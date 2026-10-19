import {
  symbols,
  advancedConfig,
  evaluateStrategy,
  entryNotional,
  protection,
  exposureVeto,
  previewOnly,
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
import { configuredProvider } from "../../../packages/ai-providers/src/index.ts";
import { createHmac, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { Decimal } from "decimal.js";
import type pg from "pg";
import { pool, tenant, audit } from "../../api/src/db.ts";
import {
  BybitAdapter,
  botConfig,
  decrypt,
  evaluate,
  risk,
  quantize,
  type Credentials,
} from "../../../packages/core/src/index.ts";
const key = process.env.APP_ENCRYPTION_KEY!;
if (!key?.match(/^[a-f0-9]{64}$/i))
  throw Error("APP_ENCRYPTION_KEY is required");
const feeds = new Map<
  string,
  {
    socket: WebSocket;
    authenticated: boolean;
    lastMessage: number;
    credentials: Credentials;
  }
>();
const market = new Map<string, number>();
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
const wsOptions = proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {};
let publicSocket: WebSocket | null = null;
let closing = false;
function publicFeed() {
  if (closing) return;
  const socket = new WebSocket(
    "wss://stream-testnet.bybit.com/v5/public/spot",
    wsOptions,
  );
  publicSocket = socket;
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
        market.set(message.topic.split(".").at(-1), Date.now());
    } catch {}
  });
  socket.on("error", () => socket.close());
  socket.on("close", () => {
    market.clear();
    if (!closing) setTimeout(publicFeed, 5000);
  });
}
function privateFeed(id: string, credentials: Credentials) {
  let feed = feeds.get(id);
  if (feed) return feed;
  const socket = new WebSocket(
    "wss://stream-testnet.bybit.com/v5/private",
    wsOptions,
  );
  feed = { socket, authenticated: false, lastMessage: 0, credentials };
  feeds.set(id, feed);
  const current = feed;
  socket.on("open", () => {
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
    try {
      const m = JSON.parse(data.toString());
      if (m.op === "auth" && m.success) {
        current.authenticated = true;
        socket.send(
          JSON.stringify({
            op: "subscribe",
            args: ["order", "execution", "wallet"],
          }),
        );
      }
      current.lastMessage = Date.now();
    } catch {
      current.authenticated = false;
    }
  });
  socket.on("error", () => socket.close());
  socket.on("close", () => {
    feeds.delete(id);
  });
  return current;
}
// No blind retry of createOrder. Uncertain submissions remain locked until reconciled.
export async function reconcile(
  db: pg.PoolClient,
  tid: string,
  connectionId: string,
  adapter: BybitAdapter,
) {
  const [open, executions] = await Promise.all([
    adapter.getOpenOrders(),
    adapter.getExecutions(),
  ]);
  const ours = await db.query(
    "SELECT o.* FROM orders o JOIN bots b ON b.id=o.bot_id WHERE b.connection_id=$1 AND o.tenant_id=$2",
    [connectionId, tid],
  );
  const byClient = new Map(ours.rows.map((o) => [o.client_id, o]));
  if (open.nextPageCursor || executions.nextPageCursor)
    throw Error("PAGINATED_HISTORY_REQUIRES_REVIEW");
  for (const o of open.list ?? [])
    if (!byClient.has(o.orderLinkId)) throw Error("UNEXPECTED_EXCHANGE_ORDER");
  for (const fill of [...(executions.list ?? [])].reverse()) {
    const order = byClient.get(fill.orderLinkId);
    if (!order) continue;
    if (fill.feeCurrency && fill.feeCurrency !== "USDT")
      throw Error("NON_QUOTE_FEE_REQUIRES_RECONCILIATION");
    const inserted = await db.query(
      "INSERT INTO executions(id,tenant_id,order_id,quantity,price,fee,executed_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id",
      [
        fill.execId,
        tid,
        order.id,
        fill.execQty,
        fill.execPrice,
        fill.execFee,
        new Date(Number(fill.execTime)),
      ],
    );
    if (!inserted.rowCount) continue;
    const p = (
      await db.query(
        "SELECT * FROM positions WHERE bot_id=$1 AND tenant_id=$2 FOR UPDATE",
        [order.bot_id, tid],
      )
    ).rows[0];
    const qty = new Decimal(p.quantity),
      cost = new Decimal(p.cost),
      q = new Decimal(fill.execQty),
      price = new Decimal(fill.execPrice),
      fee = new Decimal(fill.execFee);
    if (order.side === "Buy") {
      await db.query(
        "UPDATE positions SET quantity=$1,cost=$2,fees=fees+$3,high_watermark=GREATEST(high_watermark,$6),last_entry_price=$6,last_entry_at=$8,entry_count=entry_count+CASE WHEN (SELECT count(*) FROM executions WHERE order_id=$7)=1 THEN 1 ELSE 0 END,updated_at=now() WHERE bot_id=$4 AND tenant_id=$5",
        [
          qty.plus(q).toString(),
          cost.plus(q.mul(price)).toString(),
          fee.toString(),
          order.bot_id,
          tid,
          price.toString(),
          order.id,
          new Date(Number(fill.execTime)),
        ],
      );
    } else {
      if (q.gt(qty)) throw Error("SELL_EXCEEDS_TRACKED_POSITION");
      const basis = qty.isZero() ? new Decimal(0) : cost.div(qty).mul(q);
      await db.query(
        "UPDATE positions SET quantity=$1,cost=$2,realized_pnl=realized_pnl+$3,fees=fees+$4,high_watermark=CASE WHEN $1::numeric=0 THEN 0 ELSE high_watermark END,entry_count=CASE WHEN $1::numeric=0 THEN 0 ELSE entry_count END,updated_at=now() WHERE bot_id=$5 AND tenant_id=$6",
        [
          qty.minus(q).toString(),
          cost.minus(basis).toString(),
          q.mul(price).minus(basis).toString(),
          fee.toString(),
          order.bot_id,
          tid,
        ],
      );
    }
  }
  for (const order of ours.rows.filter(
    (o) =>
      !["Filled", "Cancelled", "Rejected", "Deactivated"].includes(o.state),
  )) {
    const response = await adapter.getOrder(order.client_id);
    const remote = response.list?.[0];
    if (!remote) {
      if (order.state === "INTERNAL_CREATED") continue;
      throw Error("ORDER_OUTCOME_UNKNOWN");
    }
    await db.query(
      "UPDATE orders SET state=$1,exchange_id=$2,updated_at=now() WHERE id=$3 AND tenant_id=$4",
      [remote.orderStatus, remote.orderId, order.id, tid],
    );
  }
}
async function tick(tid: string, botId: string) {
  await tenant(tid, async (db) => {
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
        "SELECT b.*,c.environment,c.credentials,c.status AS connection_status FROM bots b JOIN exchange_connections c ON c.id=b.connection_id WHERE b.id=$1 AND b.tenant_id=$2 FOR UPDATE OF b,c",
        [botId, tid],
      )
    ).rows[0];
    if (
      !row ||
      !["STARTING", "RUNNING", "PAUSED", "STOPPED"].includes(row.status) ||
      row.environment !== "TESTNET" ||
      row.connection_status !== "CONNECTED"
    )
      return;
    const credentials = decrypt<Credentials>(
        row.credentials,
        key,
        `${tid}:${row.connection_id}:${row.environment}`,
      ),
      adapter = new BybitAdapter("TESTNET", credentials),
      feed = privateFeed(row.connection_id, credentials);
    const hasOrders = (
      await db.query(
        "SELECT 1 FROM orders WHERE bot_id=$1 AND tenant_id=$2 LIMIT 1",
        [botId, tid],
      )
    ).rowCount;
    if (!["STARTING", "RUNNING"].includes(row.status) && !hasOrders) return;
    if (!feed.authenticated || Date.now() - feed.lastMessage > 45000) return;
    await reconcile(db, tid, row.connection_id, adapter);
    if (!["STARTING", "RUNNING"].includes(row.status)) return;
    const p = (
      await db.query(
        "SELECT * FROM positions WHERE bot_id=$1 AND tenant_id=$2",
        [botId, tid],
      )
    ).rows[0];
    const pending = (
      await db.query(
        "SELECT 1 FROM orders WHERE bot_id=$1 AND tenant_id=$2 AND state NOT IN ('Filled','Cancelled','Rejected','Deactivated')",
        [botId, tid],
      )
    ).rowCount;
    if (pending) return;
    if (row.status === "STARTING") {
      await db.query(
        "UPDATE bots SET status='RUNNING' WHERE id=$1 AND tenant_id=$2",
        [botId, tid],
      );
      await audit(db, tid, "BOT_RECONCILED", { botId });
      row.status = "RUNNING";
    }
    const advanced = advancedConfig.parse(row.advanced_config);
    if (previewOnly(row.strategy_version, advanced)) return;
    const config = botConfig.parse(row.config),
      ticker = (await adapter.getTicker(row.symbol)).list[0],
      price = Number(ticker.lastPrice),
      now = Date.now();
    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      now - (market.get(row.symbol) ?? 0) > 45000
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
    const news = mode === "OFF" ? [] : await recentNews(db, last.time + 900000);
    const newsRevision = contextKey(
      { id: "news", model: "high-impact" },
      news.filter((n) => (n.impact ?? 0) >= 0.8),
    );
    if (!stop && String(row.last_candle) === String(last.time)) {
      if (mode !== "OFF" && row.last_ai_news !== newsRevision) {
        const refreshed = await analyzeBot(
          db,
          tid,
          botId,
          mode,
          buildMarketInput(candles, news, Date.now(), row.symbol),
          "NONE",
          false,
          configuredProvider(),
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
        "SELECT count(*) FILTER(WHERE o.side='Buy') AS trades, COALESCE(sum(CASE WHEN o.side='Sell' THEN e.quantity*e.price ELSE -e.quantity*e.price END-e.fee),0) AS cashflow FROM executions e JOIN orders o ON o.id=e.order_id WHERE o.bot_id=$1 AND e.tenant_id=$2 AND e.executed_at>=date_trunc('day',now())",
        [botId, tid],
      )
    ).rows[0];
    const controls = (
      await db.query(
        "SELECT execution_stopped FROM platform_controls WHERE id=true",
      )
    ).rows[0];
    const dailyPnl = Math.min(
      0,
      Number(stats.cashflow) + Number(p.quantity) * price,
    );
    const rejection = risk({
      config: { ...config, maxTrade: proposedNotional },
      status: row.status,
      environment: row.environment,
      liveEnabled: false,
      connected: true,
      fresh:
        now - last.time < 1800000 &&
        now - (market.get(row.symbol) ?? 0) < 45000,
      reconciled: true,
      globalStop: controls.execution_stopped,
      exposure: Number(p.cost),
      dailyPnl,
      trades: Number(stats.trades),
      drawdownPct: Math.max(
        0,
        (-(
          Number(p.realized_pnl) -
          Number(p.fees) +
          Number(p.quantity) * price -
          Number(p.cost)
        ) /
          config.capital) *
          100,
      ),
      consecutiveLosses: 0,
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
    // Entries are conservatively locked after any realized loss until operator review.
    if (Number(p.realized_pnl) - Number(p.fees) < 0)
      rejection.push("REALIZED_LOSS_REVIEW_REQUIRED");
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
            configuredProvider(),
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
        stop ? now : last.time,
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
      process.env.TRADING_EXECUTION_ENABLED !== "true"
    )
      return;
    const instrument = (await adapter.getInstrument(row.symbol)).list[0],
      side = exit ? "Sell" : "Buy",
      qty = quantize(
        exit
          ? positionQty.toString()
          : new Decimal(proposedNotional)
              .mul(analysis.gate.modifier)
              .div(new Decimal(ticker.ask1Price).mul(1.01))
              .toString(),
        instrument.lotSizeFilter.basePrecision,
      );
    const instrumentReasons = instrumentVeto(
      qty,
      price,
      instrument.lotSizeFilter,
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
      clientId = orderId;
    await db.query(
      "INSERT INTO orders(id,tenant_id,bot_id,signal_id,client_id,side,quantity,state,symbol,requested_notional) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        orderId,
        tid,
        botId,
        signalId,
        clientId,
        side,
        qty,
        "SUBMITTING",
        row.symbol,
        exit
          ? new Decimal(qty).mul(price).toFixed()
          : new Decimal(proposedNotional).mul(analysis.gate.modifier).toFixed(),
      ],
    );
    // Persist intent before network I/O. Pending intents prevent another worker from submitting.
    // Reacquire locks and re-read status before submission.
    await db.query("COMMIT");
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.tenant_id',$1,true)", [tid]);
    await lockPortfolio(db, tid);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      botId,
    ]);
    const current = (
      await db.query(
        "SELECT b.status,c.status AS connection_status FROM bots b JOIN exchange_connections c ON c.id=b.connection_id WHERE b.id=$1 AND b.tenant_id=$2 FOR UPDATE OF b,c",
        [botId, tid],
      )
    ).rows[0];
    if (
      current.status !== "RUNNING" ||
      current.connection_status !== "CONNECTED" ||
      Date.now() - (market.get(row.symbol) ?? 0) > 45000 ||
      (!exit && !aiGate(mode, signal.direction, analysis.outcome).allowed) ||
      (
        await db.query(
          "SELECT execution_stopped FROM platform_controls WHERE id=true",
        )
      ).rows[0].execution_stopped
    ) {
      await db.query(
        "UPDATE orders SET state='Cancelled' WHERE id=$1 AND tenant_id=$2",
        [orderId, tid],
      );
      return;
    }
    try {
      const result = await adapter.placeOrder({
        symbol: row.symbol,
        side,
        qty,
        orderLinkId: clientId,
      });
      await db.query(
        "UPDATE orders SET state='SUBMITTED',exchange_id=$1 WHERE id=$2 AND tenant_id=$3",
        [result.orderId, orderId, tid],
      );
      await audit(db, tid, "ORDER_SUBMITTED", { botId, orderId });
    } catch {
      await db.query(
        "UPDATE bots SET status='RISK_LOCKED' WHERE id=$1 AND tenant_id=$2",
        [botId, tid],
      );
      await audit(db, tid, "ORDER_OUTCOME_REQUIRES_RECONCILIATION", {
        botId,
        orderId,
      });
    }
  });
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
  publicFeed();
  const shutdown = () => {
    closing = true;
    publicSocket?.close();
    for (const feed of feeds.values()) feed.socket.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  const heartbeat = setInterval(() => {
    for (const f of feeds.values())
      if (f.socket.readyState === WebSocket.OPEN)
        f.socket.send(JSON.stringify({ op: "ping" }));
    if (publicSocket?.readyState === WebSocket.OPEN)
      publicSocket.send(JSON.stringify({ op: "ping" }));
  }, 20000);
  let newsJob: Promise<void> | null = null,
    marketJob: Promise<void> | null = null;
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

  await Promise.allSettled([newsJob, marketJob]);
  await closeIntelligence();
  await pool.end();
}
