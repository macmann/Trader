import { bybitTestnetEndpoints } from "../../../packages/exchanges/src/index.ts";
import { runtimeProvider } from "../../api/src/installation.ts";
import { writeFile } from "node:fs/promises";
import { PrivateFeedState } from "./private-state.ts";
import { paperCycle } from "./paper.ts";
import {
  exchangeAdapter,
  type ExchangeAdapter,
  type ExchangeCredentials,
} from "../../../packages/exchanges/src/index.ts";
import { notificationCycle } from "./notifications.ts";
import { reconcile, orderEvent, terminal } from "./ledger.ts";
export { reconcile } from "./ledger.ts";
import {
  dispatchIntent,
  managePending,
  type ExecutionRuntime,
} from "./execution.ts";
import {
  symbols,
  advancedConfig,
  evaluateStrategy,
  entryNotional,
  protection,
  exposureVeto,
  instrumentVeto,
} from "../../../packages/trading/src/index.ts";
import { lockPortfolio, portfolioSnapshot } from "../../api/src/portfolio.ts";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  buildMarketInput,
  aiGate,
  entryDecision,
  contextKey,
  type AIMode,
} from "../../../packages/ai-core/src/index.ts";
import {
  analyzeBot,
  recentNews,
  newsCycle,
  warmAIContext,
  closeIntelligence,
} from "./intelligence.ts";
import { createHmac, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { Decimal } from "decimal.js";
import type pg from "pg";
import { pool, tenant, audit } from "../../api/src/db.ts";
import {
  botConfig,
  decrypt,
  risk,
  quantize,
} from "../../../packages/core/src/index.ts";
const key = process.env.APP_ENCRYPTION_KEY!;
if (!key?.match(/^[a-f0-9]{64}$/i))
  throw Error("APP_ENCRYPTION_KEY is required");
const feeds = new Map<
  string,
  {
    socket: WebSocket;
    state: PrivateFeedState;
    provider: string;
  }
>();
const market = new Map<string, number>();
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
const wsOptions = proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {};
const publicSockets = new Map<"BYBIT" | "BYBIT_EU_TESTNET", WebSocket>();
let okxSocket: WebSocket | null = null;
let closing = false;
function publicFeed(provider: "BYBIT" | "BYBIT_EU_TESTNET") {
  if (closing) return;
  const socket = new WebSocket(
    bybitTestnetEndpoints(provider).public,
    wsOptions,
  );
  publicSockets.set(provider, socket);
  socket.on("open", () =>
    socket.send(
      JSON.stringify({
        op: "subscribe",
        args: symbols.flatMap((symbol) => [
          `tickers.${symbol}`,
          `kline.15.${symbol}`,
        ]),
      }),
    ),
  );
  socket.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (
        message.topic &&
        Number.isFinite(message.ts) &&
        Math.abs(Date.now() - message.ts) < 45000
      )
        market.set(
          provider + ":" + message.topic.split(".").at(-1),
          Date.now(),
        );
    } catch {}
  });
  socket.on("error", () => socket.close());
  socket.on("close", () => {
    for (const symbol of symbols) market.delete(provider + ":" + symbol);
    if (!closing) setTimeout(() => publicFeed(provider), 5000);
  });
}
function okxPublicFeed() {
  if (closing) return;
  const socket = new WebSocket(
    "wss://wspap.okx.com:8443/ws/v5/public",
    wsOptions,
  );
  okxSocket = socket;
  socket.on("open", () =>
    socket.send(
      JSON.stringify({
        op: "subscribe",
        args: symbols.map((symbol) => ({
          channel: "tickers",
          instId: symbol.replace("USDT", "-USDT"),
        })),
      }),
    ),
  );
  socket.on("message", (data) => {
    try {
      const m = JSON.parse(data.toString());
      const tick = m.data?.[0];
      if (
        m.arg?.channel === "tickers" &&
        tick?.ts &&
        Math.abs(Date.now() - Number(tick.ts)) < 45000
      )
        market.set("OKX:" + m.arg.instId.replace("-", ""), Date.now());
    } catch {}
  });
  socket.on("error", () => socket.close());
  socket.on("close", () => {
    for (const symbol of symbols) market.delete("OKX:" + symbol);
    if (!closing) setTimeout(okxPublicFeed, 5000);
  });
}
function privateFeed(
  id: string,
  credentials: ExchangeCredentials,
  provider = "BYBIT",
) {
  let feed = feeds.get(id);
  if (feed) return feed;
  const socket = new WebSocket(
    provider === "OKX"
      ? "wss://wspap.okx.com:8443/ws/v5/private"
      : bybitTestnetEndpoints(provider as "BYBIT" | "BYBIT_EU_TESTNET").private,
    wsOptions,
  );
  feed = {
    socket,
    state: new PrivateFeedState(
      provider as "BYBIT" | "BYBIT_EU_TESTNET" | "OKX",
    ),
    provider,
  };
  feeds.set(id, feed);
  const current = feed;
  socket.on("open", () => {
    if (provider === "OKX") {
      const timestamp = String(Math.floor(Date.now() / 1000));
      socket.send(
        JSON.stringify({
          op: "login",
          args: [
            {
              apiKey: credentials.apiKey,
              passphrase: credentials.passphrase,
              timestamp,
              sign: createHmac("sha256", credentials.apiSecret)
                .update(timestamp + "GET/users/self/verify")
                .digest("base64"),
            },
          ],
        }),
      );
      return;
    }
    const expires = Date.now() + 10000;
    socket.send(
      JSON.stringify({
        op: "auth",
        args: [
          credentials.apiKey,
          expires,
          createHmac("sha256", credentials.apiSecret)
            .update(`GET/realtime${expires}`)
            .digest("hex"),
        ],
      }),
    );
  });
  socket.on("message", (data) => {
    const result = current.state.receive(data.toString());
    if (result === "AUTHENTICATED")
      socket.send(
        JSON.stringify(
          provider === "OKX"
            ? {
                op: "subscribe",
                args: [
                  { channel: "orders", instType: "SPOT" },
                  { channel: "account" },
                ],
              }
            : {
                op: "subscribe",
                req_id: "private-subscriptions",
                args: ["order", "execution", "wallet"],
              },
        ),
      );
    if (current.state.failed) socket.close();
  });
  socket.on("error", () => {
    current.state.invalidate();
    socket.close();
  });
  socket.on("close", () => {
    current.state.invalidate();
    if (feeds.get(id) === current) feeds.delete(id);
  });
  return current;
}
export async function tick(
  tid: string,
  botId: string,
  override?: {
    adapter: ExchangeAdapter;
    privateReady: boolean;
    marketReceivedAt: number;
    executionEnabled: boolean;
    now?: () => number;
    afterIntent?: () => Promise<void>;
    afterSubmitting?: () => Promise<void>;
  },
) {
  const clock = override?.now ?? Date.now;
  await tenant(
    tid,
    async (db) => {
      await lockPortfolio(db, tid);
      if (
        !(
          await db.query(
            "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
            [botId],
          )
        ).rows[0].locked
      )
        return;
      const row = (
        await db.query(
          "SELECT b.*,c.provider,c.environment,c.credentials,c.status AS connection_status FROM bots b JOIN exchange_connections c ON c.id=b.connection_id WHERE b.id=$1 AND b.tenant_id=$2 FOR UPDATE OF b,c",
          [botId, tid],
        )
      ).rows[0];
      if (
        !row ||
        !["STARTING", "RUNNING", "PAUSED", "STOPPED", "RISK_LOCKED"].includes(
          row.status,
        ) ||
        row.environment !== "TESTNET" ||
        row.connection_status !== "CONNECTED"
      )
        return;
      const adapter =
        override?.adapter ??
        exchangeAdapter(
          row.provider,
          "TESTNET",
          decrypt<ExchangeCredentials>(
            row.credentials,
            key,
            `${tid}:${row.connection_id}:${row.environment}`,
          ),
        );
      const feed = override
        ? null
        : privateFeed(
            row.connection_id,
            decrypt<ExchangeCredentials>(
              row.credentials,
              key,
              `${tid}:${row.connection_id}:${row.environment}`,
            ),
            row.provider,
          );
      const accountRevision = feed?.state.revision;
      const runtime: ExecutionRuntime = {
        executionEnabled:
          override?.executionEnabled ??
          process.env.TRADING_EXECUTION_ENABLED === "true",
        privateReady:
          override?.privateReady ??
          (!!feed?.state.ready(clock()) &&
            feed.socket.readyState === WebSocket.OPEN),
        marketReceivedAt:
          override?.marketReceivedAt ??
          market.get(row.provider + ":" + row.symbol) ??
          0,
        now: clock,
        isPrivateReady: () =>
          override
            ? override.privateReady
            : !!feed?.state.ready(clock()) &&
              feed.socket.readyState === WebSocket.OPEN &&
              feed.state.revision === accountRevision,
        marketTime: () =>
          override?.marketReceivedAt ??
          market.get(row.provider + ":" + row.symbol) ??
          0,
        afterSubmitting: override?.afterSubmitting,
      };
      const hasOrders = (
        await db.query(
          "SELECT 1 FROM orders WHERE bot_id=$1 AND tenant_id=$2 LIMIT 1",
          [botId, tid],
        )
      ).rowCount;
      if (!["STARTING", "RUNNING"].includes(row.status) && !hasOrders) return;
      const ready = await reconcile(db, tid, row.connection_id, adapter);
      const controls = (
        await db.query(
          "SELECT execution_stopped FROM platform_controls WHERE id=true",
        )
      ).rows[0];
      const p = (
        await db.query(
          "SELECT * FROM positions WHERE bot_id=$1 AND tenant_id=$2",
          [botId, tid],
        )
      ).rows[0];
      const stopped =
        !["STARTING", "RUNNING"].includes(row.status) ||
        controls.execution_stopped ||
        !runtime.executionEnabled;
      const pending = await managePending(db, tid, botId, adapter, {
        now: clock(),
        stop: stopped,
        protectiveExit: false,
      });
      if (!ready) {
        await db.query(
          "UPDATE bots SET status='RISK_LOCKED' WHERE id=$1 AND tenant_id=$2",
          [botId, tid],
        );
        return;
      }
      if (pending.length) {
        const internal = pending.find((o) => o.state === "INTERNAL_CREATED");
        if (internal) {
          await dispatchIntent(db, tid, internal.id, adapter, runtime);
          return;
        }
        // Inspect fresh prices to cancel resting entries before any protective exit; never sell until cancellation/fills reconcile.
        if (
          Number(p.quantity) > 0 &&
          runtime.privateReady &&
          clock() - runtime.marketReceivedAt < 45000
        ) {
          const quote = (await adapter.getTicker(row.symbol)).list?.[0];
          const check = protection({
            price: Number(quote?.lastPrice),
            position: {
              quantity: Number(p.quantity),
              cost: Number(p.cost),
              highWatermark: Number(p.high_watermark),
              lastEntryPrice: Number(p.last_entry_price),
              lastEntryAt: p.last_entry_at?.getTime() ?? 0,
              entryCount: p.entry_count,
            },
            ...botConfig.parse(row.config),
            advanced: advancedConfig.parse(row.advanced_config),
          });
          await db.query(
            "UPDATE positions SET high_watermark=$1 WHERE bot_id=$2 AND tenant_id=$3",
            [check.highWatermark, botId, tid],
          );
          if (check.exit)
            await managePending(db, tid, botId, adapter, {
              now: clock(),
              stop: stopped,
              protectiveExit: true,
            });
        }
        return;
      }
      if (
        !["STARTING", "RUNNING", "PAUSED"].includes(row.status) ||
        !runtime.privateReady
      )
        return;
      if (row.status === "STARTING") {
        await db.query(
          "UPDATE bots SET status='RUNNING' WHERE id=$1 AND tenant_id=$2",
          [botId, tid],
        );
        await audit(db, tid, "BOT_RECONCILED", { botId });
        row.status = "RUNNING";
      }
      const advanced = advancedConfig.parse(row.advanced_config);
      const config = botConfig.parse(row.config),
        ticker = (await adapter.getTicker(row.symbol)).list[0],
        price = Number(ticker.lastPrice),
        now = clock();
      if (
        !Number.isFinite(price) ||
        price <= 0 ||
        now - runtime.marketReceivedAt > 45000
      )
        return;
      const candles = (await adapter.getCandles(row.symbol)).filter(
          (c) => c.time + 900000 <= now,
        ),
        last = candles.at(-1);
      if (!last) return;
      const positionQty = new Decimal(p.quantity),
        entry = positionQty.gt(0)
          ? new Decimal(p.cost).div(positionQty).toNumber()
          : 0;
      const protectionState = protection({
        price,
        position: {
          quantity: Number(p.quantity),
          cost: Number(p.cost),
          highWatermark: Number(p.high_watermark),
          lastEntryPrice: Number(p.last_entry_price),
          lastEntryAt: p.last_entry_at?.getTime() ?? 0,
          entryCount: p.entry_count,
          gridLevelsFilled: p.grid_levels_filled,
          lastExitPrice: Number(p.last_exit_price),
        },
        stopLossPct: config.stopLossPct,
        takeProfitPct: config.takeProfitPct,
        advanced,
      });
      await db.query(
        "UPDATE positions SET high_watermark=$1 WHERE bot_id=$2 AND tenant_id=$3",
        [protectionState.highWatermark, botId, tid],
      );
      const stop = protectionState.exit;
      const mode = (row.ai_mode ?? "OFF") as AIMode;
      const news =
        mode === "OFF" ? [] : await recentNews(db, last.time + 900000);
      const newsRevision = contextKey(
        { id: "news", model: "high-impact" },
        news.filter((n) => (n.impact ?? 0) >= 0.8),
      );
      const priceDriven = [
        "dca-v1.0",
        "grid-accumulation-v1.0",
        "grid-accumulation-v1.1",
      ].includes(row.strategy_version);
      if (
        !stop &&
        !priceDriven &&
        String(row.last_candle) === String(last.time)
      ) {
        if (mode !== "OFF" && row.last_ai_news !== newsRevision) {
          const refreshed = await analyzeBot(
            db,
            tid,
            botId,
            mode,
            buildMarketInput(candles, news, Date.now(), row.symbol),
            "NONE",
            false,
            await runtimeProvider(db),
            true,
          );
          if (refreshed.outcome?.error === "AI_BUSY") return;
          await db.query(
            "UPDATE bots SET last_ai_news=$1 WHERE id=$2 AND tenant_id=$3",
            [newsRevision, botId, tid],
          );
        }
        return;
      }
      const signal = stop
        ? ({ direction: "EXIT", reasons: [protectionState.reason] } as const)
        : evaluateStrategy(
            row.strategy_version,
            candles,
            {
              quantity: Number(p.quantity),
              cost: Number(p.cost),
              highWatermark: protectionState.highWatermark,
              lastEntryPrice: Number(p.last_entry_price),
              lastEntryAt: p.last_entry_at?.getTime() ?? 0,
              entryCount: p.entry_count,
              gridLevelsFilled: p.grid_levels_filled,
              lastExitPrice: Number(p.last_exit_price),
            },
            advanced,
            price,
            now,
          );
      const balance = await adapter.getBalances(),
        coins = balance.list?.[0]?.coin ?? [],
        available = Number(
          coins.find((c: any) => c.coin === "USDT")?.walletBalance ?? 0,
        );
      // Fail closed on account-level asset discrepancies. Dedicated Testnet accounts are recommended.
      const accountBtc = Number(
          coins.find((c: any) => c.coin === row.symbol.replace(/USDT$/, ""))
            ?.walletBalance ?? 0,
        ),
        tracked = Number(
          (
            await db.query(
              "SELECT COALESCE(sum(p.quantity),0) AS qty FROM positions p JOIN bots b ON b.id=p.bot_id WHERE b.connection_id=$1 AND p.tenant_id=$2 AND b.symbol=$3",
              [row.connection_id, tid, row.symbol],
            )
          ).rows[0].qty,
        );
      if (Math.abs(accountBtc - tracked) > 0.000001)
        throw Error("UNEXPECTED_ACCOUNT_POSITION");
      const portfolio = await portfolioSnapshot(db, tid);
      const connectionExposure = portfolio.connections[row.connection_id];
      const reservedQuote = connectionExposure?.pending ?? 0;
      const proposedNotional = entryNotional(
        config.capital,
        config.maxTrade,
        config.stopLossPct,
        advanced,
      );
      const stats = (
        await db.query(
          "SELECT count(DISTINCT o.id) FILTER(WHERE o.side='Buy') AS trades,COALESCE(sum(e.realized_gross-e.fee),0) AS realized FROM executions e JOIN orders o ON o.id=e.order_id AND o.tenant_id=e.tenant_id WHERE o.bot_id=$1 AND e.tenant_id=$2 AND e.executed_at>=(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')",
          [botId, tid],
        )
      ).rows[0];
      const cycles = (
        await db.query(
          "SELECT net_pnl FROM trade_cycles WHERE tenant_id=$1 AND bot_id=$2 ORDER BY closed_at DESC,id DESC LIMIT $3",
          [tid, botId, config.maxConsecutiveLosses],
        )
      ).rows;
      let consecutiveLosses = 0;
      for (const cycle of cycles) {
        if (Number(cycle.net_pnl) < 0) consecutiveLosses++;
        else break;
      }
      const unrealized = Number(p.quantity) * price - Number(p.cost),
        dailyPnl = Number(stats.realized) + Math.min(0, unrealized);
      const equity =
          config.capital + Number(p.realized_pnl) - Number(p.fees) + unrealized,
        peak = Math.max(Number(p.peak_equity), config.capital, equity);
      await db.query(
        "UPDATE positions SET peak_equity=$1 WHERE bot_id=$2 AND tenant_id=$3",
        [peak, botId, tid],
      );
      const rejection = risk({
        config: { ...config, maxTrade: proposedNotional },
        status: row.status,
        environment: row.environment,
        liveEnabled: false,
        connected: true,
        fresh:
          now - last.time < 1800000 && now - runtime.marketReceivedAt < 45000,
        reconciled: true,
        globalStop: controls.execution_stopped,
        exposure: Number(p.cost),
        dailyPnl,
        trades: Number(stats.trades),
        drawdownPct:
          peak <= 0 ? 100 : Math.max(0, ((peak - equity) / peak) * 100),
        consecutiveLosses,
        allowScaleIn: priceDriven,
        available: Math.max(0, available - reservedQuote),
        spreadPct:
          ((Number(ticker.ask1Price) - Number(ticker.bid1Price)) / price) * 100,
      });
      rejection.push(
        ...exposureVeto({
          limits: portfolio.limits,
          total: portfolio.exposure + portfolio.reserved,
          connection: (connectionExposure?.exposure ?? 0) + reservedQuote,
          symbol:
            (portfolio.symbols[row.symbol]?.exposure ?? 0) +
            (portfolio.symbols[row.symbol]?.pending ?? 0),
          pending: portfolio.reserved,
          openPositions: portfolio.openPositions,
          newNotional: proposedNotional,
          alreadyPositioned: positionQty.gt(0),
          unknownPending: portfolio.unknownPending,
        }),
      );
      const strategyAllowed =
        signal.direction === "LONG" && rejection.length === 0;
      const analysis =
        mode !== "OFF" && signal.direction !== "EXIT"
          ? await analyzeBot(
              db,
              tid,
              botId,
              mode,
              buildMarketInput(candles, news, Date.now(), row.symbol),
              signal.direction,
              strategyAllowed,
              await runtimeProvider(db),
              true,
            )
          : {
              id: null,
              outcome: null,
              gate: aiGate(mode, signal.direction, null),
            };
      if (
        analysis.outcome?.error === "AI_BUSY" &&
        (mode === "FILTER" || signal.direction === "NONE")
      )
        return;
      const entryApproval = entryDecision(
        mode,
        signal.direction,
        rejection,
        analysis.outcome,
      );
      const exit = signal.direction === "EXIT" && positionQty.gt(0),
        buy = entryApproval.allowed;
      const signalId = randomUUID();
      const inserted = await db.query(
        "INSERT INTO signals(id,tenant_id,bot_id,candle_time,strategy_version,data,decision,ai_analysis_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id",
        [
          signalId,
          tid,
          botId,
          stop || priceDriven ? now : last.time,
          row.strategy_version,
          JSON.stringify({
            ...signal,
            symbol: row.symbol,
            protection: protectionState,
          }),
          JSON.stringify({
            approved: exit || buy,
            reasons: exit ? [] : entryApproval.reasons,
            aiMode: mode,
            aiReason: analysis.gate.reason,
            positionSizeModifier: analysis.gate.modifier,
          }),
          analysis.id,
        ],
      );
      if (!stop)
        await db.query(
          "UPDATE bots SET last_candle=$1,last_ai_news=$4 WHERE id=$2 AND tenant_id=$3",
          [last.time, botId, tid, newsRevision],
        );
      if (
        !inserted.rowCount ||
        (!exit && !buy) ||
        controls.execution_stopped ||
        !runtime.executionEnabled
      )
        return;
      const instrument = (await adapter.getInstrument(row.symbol)).list[0],
        side = exit ? "Sell" : "Buy";
      const type = exit ? "MARKET" : advanced.entryType;
      const limitPrice =
        type === "LIMIT"
          ? quantize(
              new Decimal(ticker.bid1Price)
                .mul(
                  new Decimal(1).minus(
                    new Decimal(advanced.limitOffsetPct).div(100),
                  ),
                )
                .toFixed(),
              instrument.priceFilter.tickSize,
            )
          : null;
      const reference = limitPrice ?? ticker.ask1Price;
      const qty = quantize(
        exit
          ? positionQty.toFixed()
          : new Decimal(proposedNotional)
              .mul(analysis.gate.modifier)
              .div(new Decimal(reference).mul(1.01))
              .toFixed(),
        instrument.lotSizeFilter.basePrecision,
      );
      const instrumentReasons = instrumentVeto(
        qty,
        type === "LIMIT" ? Number(limitPrice) : price,
        instrument.lotSizeFilter,
        type,
      );
      if (instrumentReasons.length) {
        await db.query(
          "UPDATE signals SET decision=decision||$1::jsonb WHERE id=$2 AND tenant_id=$3",
          [
            JSON.stringify({ approved: false, reasons: instrumentReasons }),
            signalId,
            tid,
          ],
        );
        return;
      }
      const orderId = randomUUID(),
        clientId =
          row.provider === "OKX" ? orderId.replaceAll("-", "") : orderId;
      await db.query(
        "INSERT INTO orders(id,tenant_id,bot_id,signal_id,client_id,side,quantity,state,symbol,requested_notional,order_type,limit_price,time_in_force,expires_at,strategy_version,grid_level,strategy_cycle) VALUES($1,$2,$3,$4,$5,$6,$7,'INTERNAL_CREATED',$8,$9,$10,$11,$12,$13,$14,$15,$16)",
        [
          orderId,
          tid,
          botId,
          signalId,
          clientId,
          side,
          qty,
          row.symbol,
          exit
            ? new Decimal(qty).mul(price).toFixed()
            : new Decimal(proposedNotional)
                .mul(analysis.gate.modifier)
                .toFixed(),
          type,
          limitPrice,
          advanced.limitTimeInForce,
          type === "LIMIT"
            ? new Date(now + advanced.limitTimeToLiveMinutes * 60000)
            : null,
          row.strategy_version,
          "level" in signal ? signal.level : null,
          p.strategy_cycle,
        ],
      );
      await orderEvent(db, tid, orderId, "intent", "INTERNAL_CREATED");
      await db.query("COMMIT");
      await db.query("BEGIN");
      await db.query("SELECT set_config('app.tenant_id',$1,true)", [tid]);
      if (override?.afterIntent) await override.afterIntent();
      await dispatchIntent(db, tid, orderId, adapter, runtime);
    },
    `execution:${tid}`,
  );
}
export async function startWorker() {
  const role = (
    await pool.query(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  if (role.rolsuper || role.rolbypassrls)
    throw Error("Runtime database role must enforce row-level security");
  console.log(
    JSON.stringify({
      event: "WORKER_STARTED",
      executionEnabled: process.env.TRADING_EXECUTION_ENABLED === "true",
      liveEnabled: false,
    }),
  );
  publicFeed("BYBIT");
  publicFeed("BYBIT_EU_TESTNET");
  okxPublicFeed();
  const shutdown = () => {
    closing = true;
    for (const socket of publicSockets.values()) socket.close();
    okxSocket?.close();
    for (const feed of feeds.values()) feed.socket.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  const heartbeat = setInterval(() => {
    for (const f of feeds.values())
      if (f.socket.readyState === WebSocket.OPEN)
        f.socket.send(
          f.provider === "OKX" ? "ping" : JSON.stringify({ op: "ping" }),
        );
    if (okxSocket?.readyState === WebSocket.OPEN) okxSocket.send("ping");
    for (const socket of publicSockets.values())
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ op: "ping" }));
  }, 20000);
  let newsJob: Promise<void> | null = null,
    marketJob: Promise<void> | null = null,
    paperJob: Promise<void> | null = null,
    notificationJob: Promise<void> | null = null;
  let lastPaper = 0,
    lastNotifications = 0;
  while (!closing) {
    try {
      if (!newsJob)
        newsJob = newsCycle()
          .catch(() =>
            console.error(JSON.stringify({ event: "NEWS_CYCLE_FAILED" })),
          )
          .finally(() => {
            newsJob = null;
          });
      if (!marketJob)
        marketJob = warmAIContext()
          .catch(() =>
            console.error(
              JSON.stringify({ event: "AI_CONTEXT_REFRESH_FAILED" }),
            ),
          )
          .finally(() => {
            marketJob = null;
          });
      const tenants = await pool.query("SELECT id FROM workspaces");
      const active = new Set<string>();
      for (const w of tenants.rows) {
        const bots = await tenant(
          w.id,
          async (db) =>
            (
              await db.query(
                "SELECT b.id,b.connection_id FROM bots b JOIN exchange_connections c ON c.id=b.connection_id WHERE b.tenant_id=$1 AND c.status='CONNECTED'",
                [w.id],
              )
            ).rows,
        );
        for (const b of bots) {
          active.add(b.connection_id);
          try {
            await tick(w.id, b.id);
          } catch (e) {
            console.error(
              JSON.stringify({
                event: "BOT_CHECK_FAILED",
                botId: b.id,
                errorType: e instanceof Error ? e.name : "Unknown",
              }),
            );
            await tenant(w.id, async (db) => {
              await db.query(
                "UPDATE bots SET status='RISK_LOCKED' WHERE id=$1 AND tenant_id=$2",
                [b.id, w.id],
              );
              await audit(db, w.id, "RECONCILIATION_FAILED", { botId: b.id });
            });
          }
        }
      }
      if (!paperJob && Date.now() - lastPaper >= 30000) {
        lastPaper = Date.now();
        paperJob = paperCycle()
          .catch(() =>
            console.error(JSON.stringify({ event: "PAPER_CYCLE_FAILED" })),
          )
          .finally(() => {
            paperJob = null;
          });
      }
      if (!notificationJob && Date.now() - lastNotifications >= 10000) {
        lastNotifications = Date.now();
        notificationJob = notificationCycle()
          .catch(() =>
            console.error(
              JSON.stringify({ event: "NOTIFICATION_CYCLE_FAILED" }),
            ),
          )
          .finally(() => {
            notificationJob = null;
          });
      }
      await writeFile("/tmp/trader-worker-heartbeat", String(Date.now()), {
        mode: 0o600,
      });
      for (const [id, f] of feeds)
        if (!active.has(id)) {
          f.socket.close();
          feeds.delete(id);
        }
    } catch {
      console.error(JSON.stringify({ event: "WORKER_CYCLE_FAILED" }));
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  clearInterval(heartbeat);

  await Promise.allSettled([newsJob, marketJob, paperJob, notificationJob]);
  await closeIntelligence();
  await pool.end();
}
