import { recoverMissingOrder } from "./order-recovery.ts";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import {
  botConfig,
  risk,
  quantize,
  ExchangeError,
  definitiveOrderRejection,
} from "../../../packages/core/src/index.ts";
import {
  duration,
  validateCandles,
} from "../../../packages/trading/src/creator.ts";
import {
  advancedConfig,
  exposureVeto,
  instrumentVeto,
} from "../../../packages/trading/src/index.ts";
import type { PerpetualAdapter } from "../../../packages/exchanges/src/perpetuals.ts";
import type { AIProvider } from "../../../packages/ai-core/src/index.ts";
import { tenant, audit } from "../../api/src/db.ts";
import { entitlements } from "../../api/src/platform.ts";
import { testnetExecutionEnabled } from "../../api/src/installation.ts";
import { portfolioSnapshot, lockPortfolio } from "../../api/src/portfolio.ts";
import { reconcile, terminal, orderEvent } from "./ledger.ts";
import { aiStrategy } from "./ai-strategy.ts";
import type { BotObservation } from "./monitoring.ts";
import type { ExecutionRuntime } from "./execution.ts";
const D = (v: unknown) => new Decimal(String(v));
export function estimatedMargin(notional: number, leverage: number) {
  return notional / leverage + notional * 0.003;
}
async function reservedMargin(
  db: pg.PoolClient,
  tid: string,
  connectionId: string,
) {
  return Number(
    (
      await db.query(
        "SELECT COALESCE(sum(CASE WHEN o.market_type='LINEAR' THEN o.requested_notional/o.leverage+o.requested_notional*0.003 ELSE o.requested_notional END),0) AS amount FROM orders o JOIN bots b ON b.id=o.bot_id AND b.tenant_id=o.tenant_id WHERE o.tenant_id=$1 AND b.connection_id=$2 AND NOT(o.state=ANY($3::text[])) AND ((o.market_type='LINEAR' AND o.purpose='ENTRY') OR (o.market_type='SPOT' AND o.side='Buy'))",
        [tid, connectionId, terminal],
      )
    ).rows[0].amount,
  );
}
export async function assertContract(
  db: pg.PoolClient,
  tid: string,
  bot: any,
  adapter: PerpetualAdapter,
) {
  const p = (
    await db.query(
      "SELECT p.*,b.leverage AS bot_leverage FROM positions p JOIN bots b ON b.id=p.bot_id AND b.tenant_id=p.tenant_id WHERE p.bot_id=$1 AND p.tenant_id=$2",
      [bot.id, tid],
    )
  ).rows[0];
  const remote = await adapter.contractPositions();
  if (remote.length > 1) throw Error("UNEXPECTED_FUTURES_POSITION");
  const actual = remote[0];
  if (actual && (!actual.isolated || !D(actual.leverage).eq(p.bot_leverage)))
    throw Error("FUTURES_LEVERAGE_OR_MARGIN_MISMATCH");
  if (
    (!actual && !D(p.quantity).isZero()) ||
    (actual &&
      (!D(actual.quantity).eq(p.quantity) ||
        actual.direction !== p.position_direction))
  )
    throw Error("UNEXPECTED_FUTURES_POSITION");
  if (
    actual &&
    (!D(actual.entryPrice).isFinite() ||
      D(actual.entryPrice).lte(0) ||
      D(actual.entryPrice)
        .minus(D(p.cost).div(p.quantity))
        .abs()
        .gt(D(actual.entryPrice).mul("0.00001")))
  )
    throw Error("FUTURES_ENTRY_PRICE_MISMATCH");
  return { p, remote: actual };
}
async function reconcileFunding(
  db: pg.PoolClient,
  tid: string,
  bot: any,
  adapter: PerpetualAdapter,
) {
  const first = (
    await db.query(
      "SELECT min(e.executed_at) AS at FROM executions e JOIN orders o ON o.id=e.order_id AND o.tenant_id=e.tenant_id WHERE o.bot_id=$1 AND o.tenant_id=$2 AND o.market_type='LINEAR'",
      [bot.id, tid],
    )
  ).rows[0].at;
  if (!first) return;
  const since = Math.max(new Date(first).getTime(), Date.now() - 7 * 86400000);
  for (const f of await adapter.funding(since)) {
    if (
      !f.id ||
      !Number.isSafeInteger(f.time) ||
      f.time < since ||
      f.time > Date.now() + 300000 ||
      !D(f.amount).isFinite()
    )
      throw Error("FUNDING_EVENT_INVALID");
    const inserted = await db.query(
      "INSERT INTO futures_funding(tenant_id,bot_id,event_id,amount,occurred_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING event_id",
      [tid, bot.id, f.id, f.amount, new Date(f.time)],
    );
    if (inserted.rowCount)
      await db.query(
        "UPDATE positions SET funding_total=funding_total+$1 WHERE tenant_id=$2 AND bot_id=$3",
        [f.amount, tid, bot.id],
      );
    else {
      const old = (
        await db.query(
          "SELECT amount,occurred_at FROM futures_funding WHERE tenant_id=$1 AND bot_id=$2 AND event_id=$3",
          [tid, bot.id, f.id],
        )
      ).rows[0];
      if (!D(old.amount).eq(f.amount) || old.occurred_at.getTime() !== f.time)
        throw Error("FUNDING_EVENT_CONFLICT");
    }
  }
}
async function cancelIntent(
  db: pg.PoolClient,
  tid: string,
  id: string,
  reason: string,
) {
  await db.query(
    "UPDATE orders SET state='Cancelled',updated_at=now() WHERE id=$1 AND tenant_id=$2",
    [id, tid],
  );
  await orderEvent(db, tid, id, "local-cancel:" + reason, "Cancelled", {
    reason,
  });
}
export async function dispatchPerpetual(
  db: pg.PoolClient,
  tid: string,
  id: string,
  adapter: PerpetualAdapter,
  runtime: ExecutionRuntime,
) {
  await lockPortfolio(db, tid);
  const o = (
    await db.query(
      "SELECT o.*,b.config,b.leverage AS bot_leverage,b.status AS bot_status,b.connection_id,c.environment,c.status AS connection_status,s.decision FROM orders o JOIN bots b ON b.id=o.bot_id AND b.tenant_id=o.tenant_id JOIN exchange_connections c ON c.id=b.connection_id AND c.tenant_id=b.tenant_id JOIN signals s ON s.id=o.signal_id AND s.tenant_id=o.tenant_id WHERE o.id=$1 AND o.tenant_id=$2 FOR UPDATE OF o,b,c",
      [id, tid],
    )
  ).rows[0];
  if (!o || o.state !== "INTERNAL_CREATED") return;
  if (o.market_type !== "LINEAR")
    throw Error("FUTURES_EXECUTOR_REQUIRES_LINEAR_INTENT");
  const enabled = () =>
    runtime.isExecutionEnabled?.() ?? Promise.resolve(runtime.executionEnabled);
  const privateReady = () => runtime.isPrivateReady?.() ?? runtime.privateReady;
  const controls = () =>
    db.query("SELECT execution_stopped FROM platform_controls WHERE id=true");
  const exit = o.purpose === "EXIT";
  if (
    !(await enabled()) ||
    !privateReady() ||
    !(exit
      ? ["RUNNING", "STARTING"].includes(o.bot_status)
      : o.bot_status === "RUNNING") ||
    o.environment !== "TESTNET" ||
    o.connection_status !== "CONNECTED" ||
    (await controls()).rows[0].execution_stopped ||
    !o.decision?.approved ||
    Date.now() - o.created_at.getTime() > 45000
  ) {
    await cancelIntent(db, tid, id, "FUTURES_FINAL_GATE");
    return;
  }
  const { p } = await assertContract(db, tid, { id: o.bot_id }, adapter),
    ticker = (await adapter.getTicker(o.symbol)).list[0],
    mark = D(ticker.lastPrice),
    config = botConfig.parse(o.config);
  if (
    !mark.isFinite() ||
    mark.lte(0) ||
    !Number.isFinite(Number(ticker.observedAt)) ||
    !D(ticker.bid1Price).isFinite() ||
    !D(ticker.ask1Price).isFinite() ||
    D(ticker.bid1Price).lte(0) ||
    D(ticker.ask1Price).lt(ticker.bid1Price) ||
    Date.now() - Number(ticker.observedAt) > 45000 ||
    Number(ticker.observedAt) > Date.now() + 1000
  )
    throw Error("STALE_FUTURES_MARKET");
  if (exit) {
    if (
      o.position_direction !== p.position_direction ||
      D(o.quantity).gt(p.quantity)
    )
      throw Error("FUTURES_REDUCE_ONLY_REQUIRED");
  } else {
    const e = await entitlements(db, tid),
      count = Number(
        (
          await db.query(
            "SELECT count(*) AS n FROM bots WHERE tenant_id=$1 AND status<>'ARCHIVED'",
            [tid],
          )
        ).rows[0].n,
      );
    const snapshot = await portfolioSnapshot(db, tid),
      notional = D(o.quantity).mul(mark).mul("1.01"),
      margin = D(await adapter.availableMargin());
    const pending = await reservedMargin(db, tid, o.connection_id);
    if (
      (!e.unlimited && count > e.limits.bots) ||
      !D(p.quantity).isZero() ||
      notional.gt(config.maxTrade) ||
      notional.gt(config.capital) ||
      !margin.isFinite() ||
      margin.lt(pending) ||
      snapshot.unknownPending ||
      snapshot.exposure + snapshot.reserved > snapshot.limits.maxTotalAllocation
    ) {
      await cancelIntent(db, tid, id, "FUTURES_BUDGET_GATE");
      return;
    }
    if (
      o.leverage !== o.bot_leverage ||
      config.stopLossPct * o.leverage >= 80
    ) {
      await cancelIntent(db, tid, id, "FUTURES_LEVERAGE_CONFIGURATION_CHANGED");
      return;
    }
    await adapter.prepare(o.position_direction, o.leverage);
  }
  adapter.closeOnly = exit;
  await db.query(
    "UPDATE orders SET state='SUBMITTING',updated_at=now() WHERE id=$1 AND tenant_id=$2",
    [id, tid],
  );
  await orderEvent(db, tid, id, "submitting", "SUBMITTING", {
    reduceOnly: exit,
    leverage: o.leverage,
    marginMode: "ISOLATED",
  });
  await db.query("COMMIT");
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.tenant_id',$1,true)", [tid]);
  await lockPortfolio(db, tid);
  if (runtime.afterSubmitting) await runtime.afterSubmitting();
  const current = (
    await db.query(
      "SELECT b.status,c.status AS connection_status FROM bots b JOIN exchange_connections c ON c.id=b.connection_id AND c.tenant_id=b.tenant_id WHERE b.id=$1 AND b.tenant_id=$2",
      [o.bot_id, tid],
    )
  ).rows[0];
  if (
    !(await enabled()) ||
    !privateReady() ||
    current?.status !== "RUNNING" ||
    current.connection_status !== "CONNECTED" ||
    (await controls()).rows[0].execution_stopped ||
    Date.now() - Number(ticker.observedAt) > 45000
  ) {
    await cancelIntent(db, tid, id, "STOP_BEFORE_FUTURES_SEND");
    return;
  }
  await assertContract(db, tid, { id: o.bot_id }, adapter);
  const remoteOrders = (await adapter.getOpenOrders()).list;
  if (!Array.isArray(remoteOrders) || remoteOrders.length)
    throw Error("UNEXPECTED_EXCHANGE_ORDER");
  if (
    !privateReady() ||
    !(await enabled()) ||
    (await controls()).rows[0].execution_stopped
  ) {
    await cancelIntent(db, tid, id, "STOP_BEFORE_FUTURES_SEND");
    return;
  }
  try {
    const result = await adapter.placeOrder({
      symbol: o.symbol,
      side: o.side,
      qty: o.quantity,
      orderLinkId: o.client_id,
      orderType: "Market",
    });
    await db.query(
      "UPDATE orders SET state='SUBMITTED',exchange_id=$1,submitted_at=now(),updated_at=now() WHERE id=$2 AND tenant_id=$3",
      [result.orderId, id, tid],
    );
    await orderEvent(db, tid, id, "acknowledged", "SUBMITTED");
  } catch (error) {
    const rejected = definitiveOrderRejection(error);
    const state = rejected ? "Rejected" : "UNKNOWN";
    await db.query(
      "UPDATE orders SET state=$3,updated_at=now() WHERE id=$1 AND tenant_id=$2",
      [id, tid, state],
    );
    if (rejected) {
      await orderEvent(db, tid, id, "rejected", "Rejected", {
        reason: "ORDER_REJECTED",
        exchangeCode: error.code,
      });
      return;
    }
    await db.query(
      "UPDATE bots SET execution_resume_requested=(status IN ('STARTING','RUNNING') OR execution_resume_requested),status='RISK_LOCKED' WHERE id=$1 AND tenant_id=$2",
      [o.bot_id, tid],
    );
    await orderEvent(db, tid, id, "ambiguous", "UNKNOWN", {
      reason: "FUTURES_SUBMISSION_UNCERTAIN",
      ...(error instanceof ExchangeError
        ? { exchangeCode: error.code, status: error.status }
        : { status: "TRANSPORT_OR_SUBMISSION_ERROR" }),
    });
  }
}
export async function perpetualTick(
  db: pg.PoolClient,
  tid: string,
  bot: any,
  adapter: PerpetualAdapter,
  runtime: ExecutionRuntime,
  observe?: (s: BotObservation) => void,
  provider?: AIProvider,
) {
  const report = (
    stage: string,
    reasons: string[] = [],
    extra: Partial<BotObservation> = {},
  ) =>
    observe?.({
      stage,
      reasons,
      privateReady: runtime.privateReady,
      executionEnabled: runtime.executionEnabled,
      ...extra,
    });
  if (await recoverMissingOrder(db, tid, bot, adapter)) {
    report("STOPPED", ["RECOVERY_CHECK_COMPLETED"]);
    return;
  }
  report("RECONCILING");
  await adapter.getInstrument(bot.symbol);
  if (
    !(await reconcile(
      db,
      tid,
      bot.connection_id,
      adapter,
      "LINEAR",
      bot.symbol,
    ))
  ) {
    await db.query(
      "UPDATE bots SET status='RISK_LOCKED' WHERE id=$1 AND tenant_id=$2",
      [bot.id, tid],
    );
    report("RISK_LOCKED", ["RECONCILIATION_REQUIRED"]);
    return;
  }
  await reconcileFunding(db, tid, bot, adapter);
  let { p, remote } = await assertContract(db, tid, bot, adapter);
  if (bot.status === "RISK_LOCKED" && bot.execution_resume_requested) {
    await db.query(
      "UPDATE bots SET status='STARTING',execution_resume_requested=false WHERE id=$1 AND tenant_id=$2",
      [bot.id, tid],
    );
    bot.status = "STARTING";
    await audit(db, tid, "BOT_ORDER_RECOVERED", { botId: bot.id });
  }
  const pending = (
    await db.query(
      "SELECT * FROM orders WHERE tenant_id=$1 AND bot_id=$2 AND NOT(state=ANY($3::text[])) ORDER BY created_at",
      [tid, bot.id, terminal],
    )
  ).rows;
  const active = ["STARTING", "RUNNING"].includes(bot.status),
    stopped = (
      await db.query(
        "SELECT execution_stopped FROM platform_controls WHERE id=true",
      )
    ).rows[0].execution_stopped;
  if (!active || stopped || !runtime.executionEnabled) {
    for (const o of pending) {
      if (o.state === "INTERNAL_CREATED")
        await cancelIntent(db, tid, o.id, "BOT_STOPPED");
      else if (o.exchange_id) {
        await adapter.cancelOrder(bot.symbol, o.exchange_id);
        await orderEvent(
          db,
          tid,
          o.id,
          "cancel-requested",
          "CANCELLATION_REQUESTED",
        );
      }
    }
    report(bot.status, [active ? "EXECUTION_DISABLED" : "BOT_NOT_ACTIVE"]);
    return;
  }
  if (!runtime.privateReady) {
    report("WAITING_PRIVATE", ["PRIVATE_STREAM_NOT_READY"]);
    return;
  }
  if (bot.status === "STARTING") {
    await db.query(
      "UPDATE bots SET status='RUNNING' WHERE id=$1 AND tenant_id=$2",
      [bot.id, tid],
    );
    bot.status = "RUNNING";
    await audit(db, tid, "FUTURES_BOT_RECONCILED", { botId: bot.id });
  }
  if (pending.length) {
    const o = pending[0];
    if (o.state === "INTERNAL_CREATED")
      await dispatchPerpetual(db, tid, o.id, adapter, runtime);
    report("WAITING_ORDER", ["FUTURES_ORDER_PENDING"]);
    return;
  }
  const ticker = (await adapter.getTicker(bot.symbol)).list[0],
    price = Number(ticker.lastPrice),
    now = Date.now(),
    config = botConfig.parse(bot.config),
    qty = Number(p.quantity),
    entry = qty > 0 ? Number(p.cost) / qty : 0,
    mult = p.position_direction === "SHORT" ? -1 : 1;
  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(Number(ticker.observedAt)) ||
    !Number.isFinite(Number(ticker.bid1Price)) ||
    !Number.isFinite(Number(ticker.ask1Price)) ||
    Number(ticker.bid1Price) <= 0 ||
    Number(ticker.ask1Price) < Number(ticker.bid1Price) ||
    now - Number(ticker.observedAt) > 45000 ||
    Number(ticker.observedAt) > now + 1000
  ) {
    report("WAITING_MARKET_DATA", ["STALE_FUTURES_MARKET"]);
    return;
  }
  const stop = entry * (1 - (mult * config.stopLossPct) / 100),
    take = entry * (1 + (mult * config.takeProfitPct) / 100),
    unrealized = qty * (price - entry) * mult;
  const protective =
    qty > 0 &&
    ((price - stop) * mult <= 0 ||
      (price - take) * mult >= 0 ||
      (remote &&
        Number(remote.liquidationPrice) > 0 &&
        Math.abs(price - Number(remote.liquidationPrice)) / price <
          Math.min(0.05, 0.2 / bot.leverage)));
  const candles = protective
      ? []
      : (await adapter.getCandles(bot.symbol, bot.timeframe, 200)).filter(
          (c) => c.time + duration(bot.timeframe) <= now,
        ),
    last = candles.at(-1);
  const observation = {
    price,
    priceAt: now,
    marketReceivedAt: Number(ticker.observedAt),
    reconciled: true,
    futures: {
      leverage: bot.leverage,
      marginMode: "ISOLATED",
      positionDirection: qty > 0 ? p.position_direction : "FLAT",
      liquidationPrice:
        remote && Number(remote.liquidationPrice) > 0
          ? Number(remote.liquidationPrice)
          : null,
    },
    protection: {
      stopPrice: stop,
      takeProfitPrice: take,
      highWatermark: price,
      exit: !!protective,
      reason:
        qty === 0
          ? "NO_POSITION"
          : protective
            ? "FUTURES_PROTECTION_EXIT"
            : "FUTURES_SOFTWARE_PROTECTION",
    },
  };
  if (!protective && (!last || !validateCandles(candles, bot.timeframe, now))) {
    report("WAITING_CANDLE", ["MARKET_DATA_STALE_OR_INVALID"], observation);
    return;
  }
  if (!protective && String(bot.last_candle) === String(last!.time)) {
    report("WAITING_CANDLE", ["NEXT_CLOSED_CANDLE"], {
      ...observation,
      candleTime: last!.time,
    });
    return;
  }
  const signal = protective
    ? { direction: "EXIT" as const, reasons: ["FUTURES_PROTECTION_EXIT"] }
    : await aiStrategy(
        db,
        tid,
        bot,
        candles,
        {
          quantity: qty,
          cost: Number(p.cost),
          direction: p.position_direction,
        },
        now,
        provider,
      );
  const exit = signal.direction === "EXIT" && qty > 0,
    direction = signal.direction === "SHORT" ? "SHORT" : "LONG";
  const stats = (
    await db.query(
      "SELECT count(DISTINCT o.id) FILTER(WHERE o.purpose='ENTRY') AS trades,COALESCE(sum(e.realized_gross-e.fee),0) AS pnl FROM executions e JOIN orders o ON o.id=e.order_id AND o.tenant_id=e.tenant_id WHERE o.bot_id=$1 AND o.tenant_id=$2 AND e.executed_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
      [bot.id, tid],
    )
  ).rows[0];
  const funding = Number(
    (
      await db.query(
        "SELECT COALESCE(sum(amount),0) AS value FROM futures_funding WHERE tenant_id=$1 AND bot_id=$2 AND occurred_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
        [tid, bot.id],
      )
    ).rows[0].value,
  );
  const cycles = (
    await db.query(
      "SELECT net_pnl FROM trade_cycles WHERE tenant_id=$1 AND bot_id=$2 ORDER BY closed_at DESC LIMIT $3",
      [tid, bot.id, config.maxConsecutiveLosses],
    )
  ).rows;
  let losses = 0;
  for (const c of cycles) {
    if (Number(c.net_pnl) < 0) losses++;
    else break;
  }
  const equity =
      config.capital +
      Number(p.realized_pnl) +
      Number(p.funding_total) -
      Number(p.fees) +
      unrealized,
    peak = Math.max(Number(p.peak_equity), equity, config.capital);
  await db.query(
    "UPDATE positions SET peak_equity=$1 WHERE bot_id=$2 AND tenant_id=$3",
    [peak, bot.id, tid],
  );
  const portfolio = await portfolioSnapshot(db, tid),
    connection = portfolio.connections[bot.connection_id],
    free = Number(await adapter.availableMargin());
  const reasons = risk({
    config,
    status: bot.status,
    environment: "TESTNET",
    liveEnabled: false,
    connected: true,
    fresh: now - Number(ticker.observedAt) <= 45000,
    reconciled: true,
    globalStop: stopped,
    exposure: Number(p.cost),
    dailyPnl: Number(stats.pnl) + funding + Math.min(0, unrealized),
    trades: Number(stats.trades),
    drawdownPct: Math.max(0, ((peak - equity) / peak) * 100),
    consecutiveLosses: losses,
    available:
      Math.max(0, free - (await reservedMargin(db, tid, bot.connection_id))) /
      estimatedMargin(1, bot.leverage),
    spreadPct:
      ((Number(ticker.ask1Price) - Number(ticker.bid1Price)) / price) * 100,
  });
  if (config.stopLossPct * bot.leverage >= 80)
    reasons.push("STOP_LOSS_TOO_WIDE_FOR_LEVERAGE");
  reasons.push(
    ...exposureVeto({
      limits: portfolio.limits,
      total: portfolio.exposure + portfolio.reserved,
      connection: (connection?.exposure ?? 0) + (connection?.pending ?? 0),
      symbol:
        (portfolio.symbols[bot.symbol]?.exposure ?? 0) +
        (portfolio.symbols[bot.symbol]?.pending ?? 0),
      pending: portfolio.reserved,
      openPositions: portfolio.openPositions,
      newNotional: config.maxTrade,
      alreadyPositioned: qty > 0,
      unknownPending: portfolio.unknownPending,
    }),
  );
  const entryAllowed =
    ["LONG", "SHORT"].includes(signal.direction) &&
    qty === 0 &&
    reasons.length === 0;
  const sid = randomUUID();
  const inserted = await db.query(
    "INSERT INTO signals(id,tenant_id,bot_id,candle_time,strategy_version,data,decision) VALUES($1,$2,$3,$4,'ai-v1.0',$5,$6) ON CONFLICT DO NOTHING RETURNING id",
    [
      sid,
      tid,
      bot.id,
      protective ? now : last!.time,
      JSON.stringify({
        ...signal,
        marketType: "LINEAR",
        positionDirection: p.position_direction,
        markPrice: price,
        unrealizedPnl: unrealized,
        marginMode: "ISOLATED",
        leverage: bot.leverage,
      }),
      JSON.stringify({
        approved: exit || entryAllowed,
        reasons: exit ? [] : reasons,
        outcome: exit
          ? "EXIT_APPROVED"
          : entryAllowed
            ? "ENTRY_APPROVED"
            : signal.direction === "NONE"
              ? "NO_ENTRY_SIGNAL"
              : "ENTRY_REJECTED",
      }),
    ],
  );
  if (!inserted.rowCount) return;
  if (!protective)
    await db.query(
      "UPDATE bots SET last_candle=$1 WHERE id=$2 AND tenant_id=$3",
      [last!.time, bot.id, tid],
    );
  report("DECISION", exit ? [] : reasons, {
    ...observation,
    candleTime: last?.time,
  });
  if (!exit && !entryAllowed) return;
  const instrument = (await adapter.getInstrument(bot.symbol)).list[0],
    reference = exit ? price : Math.max(price, Number(ticker.ask1Price)),
    quantity = quantize(
      exit
        ? String(qty)
        : D(config.maxTrade).div(D(reference).mul("1.01")).toFixed(),
      instrument.lotSizeFilter.basePrecision,
    );
  await db.query(
    "UPDATE signals SET data=data||$1::jsonb WHERE id=$2 AND tenant_id=$3",
    [
      JSON.stringify({
        proposedQuantity: quantity,
        instrument: instrument.lotSizeFilter,
      }),
      sid,
      tid,
    ],
  );
  const invalid = instrumentVeto(
    quantity,
    price,
    instrument.lotSizeFilter,
    "MARKET",
  );
  if (invalid.length) {
    await db.query(
      "UPDATE signals SET decision=$1 WHERE id=$2 AND tenant_id=$3",
      [JSON.stringify({ approved: false, reasons: invalid }), sid, tid],
    );
    return;
  }
  const positionDirection = exit ? p.position_direction : direction,
    side = (positionDirection === "LONG") !== exit ? "Buy" : "Sell",
    oid = randomUUID(),
    client = randomUUID().replaceAll("-", "");
  await db.query(
    "INSERT INTO orders(id,tenant_id,bot_id,signal_id,client_id,side,quantity,state,symbol,requested_notional,strategy_version,strategy_cycle,market_type,purpose,position_direction,created_at,leverage) VALUES($1,$2,$3,$4,$5,$6,$7,'INTERNAL_CREATED',$8,$9,'ai-v1.0',$10,'LINEAR',$11,$12,$13,$14)",
    [
      oid,
      tid,
      bot.id,
      sid,
      client,
      side,
      quantity,
      bot.symbol,
      exit ? D(quantity).mul(price).toFixed() : String(config.maxTrade),
      p.strategy_cycle,
      exit ? "EXIT" : "ENTRY",
      positionDirection,
      new Date(now),
      bot.leverage,
    ],
  );
  await orderEvent(db, tid, oid, "intent", "INTERNAL_CREATED", {
    marketType: "LINEAR",
    purpose: exit ? "EXIT" : "ENTRY",
    direction: positionDirection,
  });
  await db.query("COMMIT");
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.tenant_id',$1,true)", [tid]);
  await dispatchPerpetual(db, tid, oid, adapter, runtime);
  const finalStatus = (
    await db.query("SELECT status FROM bots WHERE id=$1 AND tenant_id=$2", [
      bot.id,
      tid,
    ])
  ).rows[0].status;
  report(
    finalStatus === "RISK_LOCKED" ? "RISK_LOCKED" : "ORDER_INTENT",
    finalStatus === "RISK_LOCKED" ? ["FUTURES_SUBMISSION_UNCERTAIN"] : [],
    observation,
  );
}
