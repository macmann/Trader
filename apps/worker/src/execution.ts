import { testnetExecutionEnabled } from "../../api/src/installation.ts";
import { entitlements } from "../../api/src/platform.ts";
import type { ExchangeAdapter } from "../../../packages/exchanges/src/index.ts";
import type pg from "pg";
import { Decimal } from "decimal.js";
import { botConfig, ExchangeError } from "../../../packages/core/src/index.ts";
import { aiGate } from "../../../packages/ai-core/src/index.ts";
import { portfolioSnapshot, lockPortfolio } from "../../api/src/portfolio.ts";
import { orderEvent, terminal } from "./ledger.ts";
export type ExecutionRuntime = {
  executionEnabled: boolean;
  isExecutionEnabled?: () => Promise<boolean>;
  privateReady: boolean;
  marketReceivedAt: number;
  now: () => number;
  isPrivateReady?: () => boolean;
  marketTime?: () => number;
  afterSubmitting?: () => Promise<void>;
};
async function cancelInternal(
  db: pg.PoolClient,
  tid: string,
  id: string,
  reason: string,
) {
  await db.query(
    "UPDATE orders SET state='Cancelled',updated_at=now() WHERE tenant_id=$1 AND id=$2",
    [tid, id],
  );
  await orderEvent(db, tid, id, "local-cancel:" + reason, "Cancelled", {
    reason,
  });
}
export async function dispatchIntent(
  db: pg.PoolClient,
  tid: string,
  id: string,
  adapter: ExchangeAdapter,
  runtime: ExecutionRuntime,
) {
  await lockPortfolio(db, tid);
  const o = (
    await db.query(
      "SELECT o.*,b.status AS bot_status,b.config,b.ai_mode,c.environment,c.status AS connection_status,s.ai_analysis_id,s.decision FROM orders o JOIN bots b ON b.id=o.bot_id AND b.tenant_id=o.tenant_id JOIN exchange_connections c ON c.id=b.connection_id AND c.tenant_id=b.tenant_id LEFT JOIN signals s ON s.id=o.signal_id AND s.tenant_id=o.tenant_id WHERE o.id=$1 AND o.tenant_id=$2 FOR UPDATE OF o,b,c",
      [id, tid],
    )
  ).rows[0];
  if (!o || o.state !== "INTERNAL_CREATED") return false;
  const privateReady = () => runtime.isPrivateReady?.() ?? runtime.privateReady;
  const marketTime = () => runtime.marketTime?.() ?? runtime.marketReceivedAt;
  const now = runtime.now(),
    control = (
      await db.query(
        "SELECT execution_stopped FROM platform_controls WHERE id=true",
      )
    ).rows[0];
  const active =
    o.bot_status === "RUNNING" ||
    (o.side === "Sell" && o.bot_status === "PAUSED");
  if (
    !runtime.executionEnabled ||
    !(await (runtime.isExecutionEnabled?.() ?? testnetExecutionEnabled(db))) ||
    !privateReady() ||
    now - marketTime() > 45000 ||
    now < marketTime() ||
    !active ||
    o.environment !== "TESTNET" ||
    o.connection_status !== "CONNECTED" ||
    control.execution_stopped ||
    o.decision?.approved !== true ||
    now - new Date(o.created_at).getTime() > 45000 ||
    (o.expires_at && o.expires_at.getTime() <= now)
  ) {
    await cancelInternal(db, tid, id, "FINAL_EXECUTION_GATE");
    return false;
  }
  if (o.side === "Buy") {
    const e = await entitlements(db, tid),
      count = Number(
        (
          await db.query(
            "SELECT count(*) AS n FROM bots WHERE tenant_id=$1 AND status<>'ARCHIVED'",
            [tid],
          )
        ).rows[0].n,
      );
    if (count > e.limits.bots) {
      await cancelInternal(db, tid, id, "SUBSCRIPTION_PLAN_LIMIT");
      return false;
    }

    if (o.ai_mode === "FILTER") {
      const a = (
        await db.query(
          "SELECT * FROM ai_analyses WHERE id=$1 AND tenant_id=$2",
          [o.ai_analysis_id, tid],
        )
      ).rows[0];
      if (
        !a ||
        !aiGate(
          "FILTER",
          "LONG",
          {
            status: a.status,
            result: a.result,
            error: a.error_code,
            createdAt: a.created_at.getTime(),
            expiresAt: a.expires_at.getTime(),
          },
          now,
        ).allowed
      ) {
        await cancelInternal(db, tid, id, "AI_ANALYSIS_STALE_OR_UNAVAILABLE");
        return false;
      }
    }
    const snapshot = await portfolioSnapshot(db, tid),
      connection =
        snapshot.connections[
          (
            await db.query(
              "SELECT connection_id FROM bots WHERE id=$1 AND tenant_id=$2",
              [o.bot_id, tid],
            )
          ).rows[0].connection_id
        ];
    const p = (
        await db.query(
          "SELECT cost FROM positions WHERE bot_id=$1 AND tenant_id=$2",
          [o.bot_id, tid],
        )
      ).rows[0],
      config = botConfig.parse(o.config);
    const ownReserved = new Decimal(
      (
        await db.query(
          "SELECT COALESCE(sum(requested_notional),0) AS n FROM orders WHERE bot_id=$1 AND tenant_id=$2 AND side='Buy' AND NOT(state=ANY($3::text[]))",
          [o.bot_id, tid, terminal],
        )
      ).rows[0].n,
    );
    if (
      snapshot.unknownPending ||
      new Decimal(p.cost).plus(ownReserved).gt(config.capital) ||
      snapshot.exposure + snapshot.reserved >
        snapshot.limits.maxTotalAllocation ||
      connection.exposure + connection.pending >
        snapshot.limits.maxConnectionAllocation ||
      (snapshot.symbols[o.symbol]?.exposure ?? 0) +
        (snapshot.symbols[o.symbol]?.pending ?? 0) >
        snapshot.limits.maxSymbolAllocation ||
      snapshot.openPositions > snapshot.limits.maxOpenPositions
    ) {
      await cancelInternal(db, tid, id, "FINAL_PORTFOLIO_GATE");
      return false;
    }
    const balances = await adapter.getBalances(),
      quote = balances.list?.[0]?.coin?.find((c: any) => c.coin === "USDT");
    const available = new Decimal(quote?.walletBalance ?? "NaN"),
      reserved = new Decimal(o.requested_notional ?? "NaN");
    if (
      !available.isFinite() ||
      !reserved.isFinite() ||
      available.lt(connection.pending)
    ) {
      await cancelInternal(db, tid, id, "FINAL_BALANCE_GATE");
      return false;
    }
    if (o.order_type === "MARKET") {
      const ticker = (await adapter.getTicker(o.symbol)).list?.[0],
        ask = new Decimal(ticker?.ask1Price ?? "NaN");
      if (
        !ask.isFinite() ||
        ask.lte(0) ||
        ask.mul(1.01).mul(o.quantity).gt(reserved)
      ) {
        await cancelInternal(db, tid, id, "PRICE_MOVED_OUTSIDE_BUDGET");
        return false;
      }
    }
  }
  // The intent exists durably before this function. Commit the attempted-send marker before I/O.
  await db.query(
    "UPDATE orders SET state='SUBMITTING',updated_at=now() WHERE id=$1 AND tenant_id=$2",
    [id, tid],
  );
  await orderEvent(db, tid, id, "submitting", "SUBMITTING");
  await db.query("COMMIT");
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.tenant_id',$1,true)", [tid]);
  await lockPortfolio(db, tid);
  // Recovering SUBMITTING never resends: the exchange outcome must be reconciled.
  if (runtime.afterSubmitting) await runtime.afterSubmitting();
  const current = (
    await db.query(
      "SELECT b.status,c.status AS connection_status FROM bots b JOIN exchange_connections c ON c.id=b.connection_id WHERE b.id=$1 AND b.tenant_id=$2 FOR UPDATE OF b,c",
      [o.bot_id, tid],
    )
  ).rows[0];
  const stopped = (
    await db.query(
      "SELECT execution_stopped FROM platform_controls WHERE id=true",
    )
  ).rows[0].execution_stopped;
  if (
    !runtime.executionEnabled ||
    !(await (runtime.isExecutionEnabled?.() ?? testnetExecutionEnabled(db))) ||
    !privateReady() ||
    runtime.now() - marketTime() > 45000 ||
    stopped ||
    current.connection_status !== "CONNECTED" ||
    (current.status !== "RUNNING" &&
      !(o.side === "Sell" && current.status === "PAUSED"))
  ) {
    await cancelInternal(db, tid, id, "STOP_BEFORE_SEND");
    return false;
  }
  try {
    const response = await adapter.placeOrder({
      symbol: o.symbol,
      side: o.side,
      qty: String(o.quantity),
      orderLinkId: o.client_id,
      orderType: o.order_type === "LIMIT" ? "Limit" : "Market",
      ...(o.order_type === "LIMIT"
        ? { price: String(o.limit_price), timeInForce: o.time_in_force }
        : {}),
    });
    await db.query(
      "UPDATE orders SET state='SUBMITTED',exchange_id=$1,submitted_at=now(),updated_at=now() WHERE id=$2 AND tenant_id=$3",
      [response.orderId, id, tid],
    );
    await orderEvent(db, tid, id, "acknowledged", "SUBMITTED");
    return true;
  } catch (e) {
    const rejected =
      e instanceof ExchangeError &&
      [10001, 110007, 170131, 170137, 170140, 170193].includes(e.code);
    await db.query(
      "UPDATE orders SET state=$1,updated_at=now() WHERE id=$2 AND tenant_id=$3",
      [rejected ? "Rejected" : "UNKNOWN", id, tid],
    );
    await orderEvent(
      db,
      tid,
      id,
      rejected ? "rejected" : "ambiguous",
      rejected ? "Rejected" : "UNKNOWN",
    );
    if (!rejected)
      await db.query(
        "UPDATE bots SET status='RISK_LOCKED' WHERE id=$1 AND tenant_id=$2",
        [o.bot_id, tid],
      );
    return false;
  }
}
export async function managePending(
  db: pg.PoolClient,
  tid: string,
  botId: string,
  adapter: ExchangeAdapter,
  input: { now: number; stop: boolean; protectiveExit: boolean },
) {
  const orders = (
    await db.query(
      "SELECT * FROM orders WHERE bot_id=$1 AND tenant_id=$2 AND NOT(state=ANY($3::text[])) ORDER BY created_at",
      [botId, tid, terminal],
    )
  ).rows;
  for (const o of orders) {
    const expired = o.expires_at && o.expires_at.getTime() <= input.now;
    if (
      o.state === "INTERNAL_CREATED" &&
      (input.stop || expired || input.protectiveExit)
    ) {
      await cancelInternal(db, tid, o.id, "INTENT_NO_LONGER_ACTIVE");
      continue;
    }
    if (
      o.order_type !== "LIMIT" ||
      !o.exchange_id ||
      (!input.stop && !expired && !input.protectiveExit)
    )
      continue;
    if (
      o.cancel_requested_at &&
      input.now - o.cancel_requested_at.getTime() < 5000
    )
      continue;
    await db.query(
      "UPDATE orders SET state='CANCELLING',cancel_requested_at=$1,updated_at=now() WHERE id=$2 AND tenant_id=$3",
      [new Date(input.now), o.id, tid],
    );
    await orderEvent(db, tid, o.id, "cancel:" + input.now, "CANCELLING", {
      reason: input.stop
        ? "BOT_STOP_OR_PAUSE"
        : expired
          ? "LIMIT_EXPIRED"
          : "PROTECTIVE_EXIT",
    });
    // Cancellation acknowledgement is not terminal; retain budget until REST reconciliation confirms fills and final state.
    try {
      await adapter.cancelOrder(o.symbol, o.exchange_id);
    } catch {
      await orderEvent(
        db,
        tid,
        o.id,
        "cancel-uncertain:" + input.now,
        "CANCELLING",
        { reason: "CANCELLATION_UNCONFIRMED" },
      );
    }
  }
  return (
    await db.query(
      "SELECT * FROM orders WHERE bot_id=$1 AND tenant_id=$2 AND NOT(state=ANY($3::text[])) ORDER BY created_at",
      [botId, tid, terminal],
    )
  ).rows;
}
