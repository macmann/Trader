import type pg from "pg";
import { Decimal } from "decimal.js";
import type { PerpetualAdapter } from "../../../packages/exchanges/src/perpetuals.ts";
import { orderEvent } from "./ledger.ts";
import { audit } from "../../api/src/db.ts";
async function allPages(load: (cursor?: string) => Promise<any>) {
  const rows: any[] = [],
    seen = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const result = await load(cursor);
    if (!Array.isArray(result?.list))
      throw Error("INVALID_RECONCILIATION_PAGE");
    rows.push(...result.list);
    const next = result.nextPageCursor;
    if (next === undefined || next === null || next === "") return rows;
    if (typeof next !== "string" || seen.has(next))
      throw Error("INVALID_RECONCILIATION_CURSOR");
    seen.add(next);
    cursor = next;
  }
  throw Error("PAGINATED_HISTORY_LIMIT_REACHED");
}
// Operator-assisted resolution is deliberately limited to unacknowledged OKX Demo futures orders.
export async function recoverMissingOrder(
  db: pg.PoolClient,
  tid: string,
  bot: any,
  adapter: PerpetualAdapter,
) {
  const requests = (
    await db.query(
      "SELECT * FROM orders WHERE tenant_id=$1 AND bot_id=$2 AND recovery_requested_at IS NOT NULL ORDER BY created_at FOR UPDATE",
      [tid, bot.id],
    )
  ).rows;
  if (!requests.length) return false;
  for (const o of requests) {
    let reason = "";
    const age = Date.now() - new Date(o.created_at).getTime();
    if (
      bot.provider !== "OKX" ||
      bot.environment !== "TESTNET" ||
      bot.market_type !== "LINEAR" ||
      !["STOPPED", "RISK_LOCKED"].includes(bot.status) ||
      o.state !== "UNKNOWN" ||
      o.exchange_id ||
      o.submitted_at ||
      !o.recovery_confirmed_by
    )
      reason = "RECOVERY_NOT_ELIGIBLE";
    else if (age < 600000 || age > 7 * 86400000 - 300000)
      reason = "RECOVERY_HISTORY_WINDOW_UNSUPPORTED";
    const p = (
      await db.query(
        "SELECT quantity,cost FROM positions WHERE tenant_id=$1 AND bot_id=$2",
        [tid, bot.id],
      )
    ).rows[0];
    if (
      !reason &&
      (!p || !new Decimal(p.quantity).isZero() || !new Decimal(p.cost).isZero())
    )
      reason = "RECOVERY_LOCAL_POSITION_EXISTS";
    if (
      !reason &&
      (
        await db.query(
          "SELECT 1 FROM executions WHERE tenant_id=$1 AND order_id=$2 LIMIT 1",
          [tid, o.id],
        )
      ).rowCount
    )
      reason = "RECOVERY_RECORDED_FILL_EXISTS";
    if (!reason) {
      await adapter.getInstrument(bot.symbol);
      const remote = await adapter.getOrder(o.client_id, bot.symbol);
      if (!Array.isArray(remote?.list))
        throw Error("INVALID_RECONCILIATION_PAGE");
      if (remote.list.length) reason = "RECOVERY_EXCHANGE_ORDER_FOUND";
      if (
        !reason &&
        (await allPages((cursor) => adapter.getOpenOrders(cursor))).length
      )
        reason = "RECOVERY_EXCHANGE_OPEN_ORDER_EXISTS";
      if (
        !reason &&
        (
          await allPages((cursor) =>
            adapter.getExecutions(
              cursor,
              new Date(o.created_at).getTime() - 300000,
              Date.now(),
            ),
          )
        ).length
      )
        reason = "RECOVERY_EXCHANGE_FILL_EXISTS";
      if (
        !reason &&
        (await adapter.contractPositions()).some(
          (p) => !new Decimal(p.quantity).isZero(),
        )
      )
        reason = "RECOVERY_EXCHANGE_POSITION_EXISTS";
    }
    if (!reason) {
      await db.query(
        "UPDATE orders SET state='Cancelled',recovery_requested_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [tid, o.id],
      );
      await orderEvent(db, tid, o.id, "operator-recovery", "Cancelled", {
        reason: "USER_CONFIRMED_NO_EXCHANGE_ACTIVITY",
        confirmedBy: o.recovery_confirmed_by,
        checkedAt: new Date().toISOString(),
        orderLookupEmpty: true,
        openOrdersEmpty: true,
        fillsEmpty: true,
        positionFlat: true,
        exchangeCancellation: false,
      });
      await audit(db, tid, "MISSING_ORDER_RECOVERY_COMPLETED", {
        botId: bot.id,
        orderId: o.id,
        actorUserId: o.recovery_confirmed_by,
      });
    } else {
      await db.query(
        "UPDATE orders SET recovery_requested_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [tid, o.id],
      );
      await orderEvent(
        db,
        tid,
        o.id,
        "recovery-refused:" + o.recovery_requested_at.toISOString(),
        "RECOVERY_REFUSED",
        { reason },
      );
      await audit(db, tid, "MISSING_ORDER_RECOVERY_REFUSED", {
        botId: bot.id,
        orderId: o.id,
        reason,
      });
    }
  }
  await db.query(
    "UPDATE bots SET status='STOPPED',execution_resume_requested=false WHERE tenant_id=$1 AND id=$2",
    [tid, bot.id],
  );
  return true; // Keep stopped. A separate Start runs normal reconciliation and a fresh candle evaluation.
}
