import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type pg from "pg";
import { BybitAdapter } from "../../../packages/core/src/index.ts";
export const terminal = ["Filled", "Cancelled", "Rejected", "Deactivated"];
export async function orderEvent(
  db: pg.PoolClient,
  tid: string,
  id: string,
  key: string,
  state: string,
  data: unknown = {},
) {
  await db.query(
    "INSERT INTO order_events(tenant_id,order_id,event_key,state,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [tid, id, key, state, JSON.stringify(data)],
  );
}
async function pages(load: (cursor?: string) => Promise<any>) {
  const list: any[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const response = await load(cursor);
    list.push(...(response.list ?? []));
    const next = response.nextPageCursor;
    if (!next) return list;
    if (seen.has(next)) throw Error("PAGINATED_HISTORY_CURSOR_REPEATED");
    seen.add(next);
    cursor = next;
  }
  throw Error("PAGINATED_HISTORY_LIMIT_REACHED");
}
async function applyFill(
  db: pg.PoolClient,
  tid: string,
  order: any,
  fill: any,
) {
  const q = new Decimal(fill.execQty),
    price = new Decimal(fill.execPrice),
    fee = new Decimal(fill.execFee ?? 0),
    base = order.symbol.replace(/USDT$/, "");
  if (
    ![q, price, fee].every((v) => v.isFinite()) ||
    q.lte(0) ||
    price.lte(0) ||
    fee.lt(0)
  )
    throw Error("INVALID_EXCHANGE_FILL");
  const currency = fill.feeCurrency ?? "USDT";
  if (!["USDT", base].includes(currency))
    throw Error("UNSUPPORTED_FEE_CURRENCY");
  const baseFee = currency === base ? fee : new Decimal(0),
    quoteFee = currency === base ? fee.mul(price) : fee;
  const netQ = order.side === "Buy" ? q.minus(baseFee) : q.plus(baseFee);
  if (netQ.lte(0)) throw Error("INVALID_NET_FILL");
  const inserted = await db.query(
    "INSERT INTO executions(id,tenant_id,order_id,quantity,price,fee,executed_at,fee_currency,fee_amount,net_quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,id) DO NOTHING RETURNING id",
    [
      fill.execId,
      tid,
      order.id,
      q.toFixed(),
      price.toFixed(),
      quoteFee.toFixed(),
      new Date(Number(fill.execTime)),
      currency,
      fee.toFixed(),
      order.side === "Buy" ? netQ.toFixed() : netQ.neg().toFixed(),
    ],
  );
  if (!inserted.rowCount) return;
  const cumulative = new Decimal(
    (
      await db.query(
        "SELECT sum(quantity) AS qty FROM executions WHERE tenant_id=$1 AND order_id=$2",
        [tid, order.id],
      )
    ).rows[0].qty,
  );
  if (cumulative.gt(order.quantity)) throw Error("ORDER_OVERFILLED");
  const p = (
    await db.query(
      "SELECT * FROM positions WHERE tenant_id=$1 AND bot_id=$2 FOR UPDATE",
      [tid, order.bot_id],
    )
  ).rows[0];
  const qty = new Decimal(p.quantity),
    cost = new Decimal(p.cost),
    entryFees = new Decimal(p.entry_fees),
    cycleNet = new Decimal(p.cycle_net);
  if (order.side === "Buy") {
    if (order.strategy_cycle !== p.strategy_cycle)
      throw Error("LATE_FILL_FROM_PREVIOUS_CYCLE");
    const first =
      (
        await db.query(
          "SELECT count(*)::integer AS n FROM executions WHERE tenant_id=$1 AND order_id=$2",
          [tid, order.id],
        )
      ).rows[0].n === 1;
    const levels: number[] = p.grid_levels_filled ?? [];
    if (order.grid_level !== null && !levels.includes(order.grid_level))
      levels.push(order.grid_level);
    await db.query(
      "UPDATE positions SET quantity=$1,cost=$2,fees=fees+$3,entry_fees=entry_fees+$3,cycle_net=cycle_net-$3,high_watermark=GREATEST(high_watermark,$4),last_entry_price=$4,last_entry_at=$5,entry_count=entry_count+$6,grid_levels_filled=$7,updated_at=now() WHERE tenant_id=$8 AND bot_id=$9",
      [
        qty.plus(netQ).toFixed(),
        cost.plus(netQ.mul(price)).toFixed(),
        quoteFee.toFixed(),
        price.toFixed(),
        new Date(Number(fill.execTime)),
        first ? 1 : 0,
        JSON.stringify(levels),
        tid,
        order.bot_id,
      ],
    );
  } else {
    if (netQ.gt(qty)) throw Error("SELL_EXCEEDS_TRACKED_POSITION");
    const remaining = qty.minus(netQ),
      basis = netQ.eq(qty) ? cost : cost.mul(netQ).div(qty),
      allocatedFee = netQ.eq(qty) ? entryFees : entryFees.mul(netQ).div(qty),
      gross = netQ.mul(price).minus(basis),
      net = gross.minus(quoteFee).minus(allocatedFee),
      cycle = cycleNet.plus(gross).minus(quoteFee);
    await db.query(
      "UPDATE executions SET realized_gross=$1,realized_net=$2 WHERE tenant_id=$3 AND id=$4",
      [gross.toFixed(), net.toFixed(), tid, fill.execId],
    );
    await db.query(
      "UPDATE positions SET quantity=$1,cost=$2,realized_pnl=realized_pnl+$3,fees=fees+$4,entry_fees=$5,cycle_net=$6,high_watermark=CASE WHEN $1::numeric=0 THEN 0 ELSE high_watermark END,entry_count=CASE WHEN $1::numeric=0 THEN 0 ELSE entry_count END,last_exit_price=CASE WHEN $1::numeric=0 THEN $9 ELSE last_exit_price END,grid_levels_filled=CASE WHEN $1::numeric=0 THEN '[]'::jsonb ELSE grid_levels_filled END,strategy_cycle=strategy_cycle+CASE WHEN $1::numeric=0 THEN 1 ELSE 0 END,updated_at=now() WHERE tenant_id=$7 AND bot_id=$8",
      [
        remaining.toFixed(),
        remaining.isZero() ? "0" : cost.minus(basis).toFixed(),
        gross.toFixed(),
        quoteFee.toFixed(),
        remaining.isZero() ? "0" : entryFees.minus(allocatedFee).toFixed(),
        remaining.isZero() ? "0" : cycle.toFixed(),
        tid,
        order.bot_id,
        price.toFixed(),
      ],
    );
    if (remaining.isZero())
      await db.query(
        "INSERT INTO trade_cycles(id,tenant_id,bot_id,strategy_version,net_pnl,closing_execution_id,closed_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          randomUUID(),
          tid,
          order.bot_id,
          order.strategy_version ?? "trend-v1.0",
          cycle.toFixed(),
          fill.execId,
          new Date(Number(fill.execTime)),
        ],
      );
  }
  await orderEvent(db, tid, order.id, "fill:" + fill.execId, "EXECUTION", {
    quantity: q.toFixed(),
    feeCurrency: currency,
  });
}
export async function reconcile(
  db: pg.PoolClient,
  tid: string,
  connectionId: string,
  adapter: BybitAdapter,
) {
  const connection = (
    await db.query(
      "SELECT reconciled_at,ledger_version FROM exchange_connections WHERE id=$1 AND tenant_id=$2",
      [connectionId, tid],
    )
  ).rows[0];
  if (connection?.ledger_version !== 2) throw Error("LEDGER_REBUILD_REQUIRED");
  const now = Date.now(),
    since = connection?.reconciled_at?.getTime() ?? now - 6 * 86400000;
  if (now - since > 7 * 86400000) throw Error("RECONCILIATION_WINDOW_EXCEEDED");
  const ours = (
    await db.query(
      "SELECT o.* FROM orders o JOIN bots b ON b.id=o.bot_id AND b.tenant_id=o.tenant_id WHERE b.connection_id=$1 AND o.tenant_id=$2",
      [connectionId, tid],
    )
  ).rows;
  const unfinished = ours.filter(
    (o) => !terminal.includes(o.state) && o.state !== "INTERNAL_CREATED",
  );
  const earliest = Math.min(
    since,
    ...unfinished.map((o) => new Date(o.created_at).getTime()),
  );
  if (now - earliest > 7 * 86400000)
    throw Error("RECONCILIATION_WINDOW_EXCEEDED");
  const [open, fills] = await Promise.all([
    pages((cursor) => adapter.getOpenOrders(cursor)),
    pages((cursor) =>
      adapter.getExecutions(
        cursor,
        Math.max(now - 7 * 86400000, earliest - 300000),
        now,
      ),
    ),
  ]);
  const byClient = new Map(ours.map((o) => [o.client_id, o]));
  for (const remote of open)
    if (!byClient.has(remote.orderLinkId))
      throw Error("UNEXPECTED_EXCHANGE_ORDER");
  for (const fill of [...fills].sort(
    (a, b) =>
      Number(a.execTime) - Number(b.execTime) ||
      String(a.execId).localeCompare(String(b.execId)),
  )) {
    const order = byClient.get(fill.orderLinkId);
    if (order) await applyFill(db, tid, order, fill);
  }
  let ready = true;
  for (const order of unfinished) {
    const result = await adapter.getOrder(order.client_id),
      remote = result.list?.[0];
    if (!remote) {
      ready = false;
      await db.query(
        "UPDATE orders SET state='UNKNOWN',updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [tid, order.id],
      );
      await orderEvent(db, tid, order.id, "unknown", "UNKNOWN");
      continue;
    }
    const applied = new Decimal(
      (
        await db.query(
          "SELECT COALESCE(sum(quantity),0) AS qty FROM executions WHERE tenant_id=$1 AND order_id=$2",
          [tid, order.id],
        )
      ).rows[0].qty,
    );
    const expected =
      remote.cumExecQty === undefined
        ? remote.orderStatus === "Filled"
          ? new Decimal(order.quantity)
          : null
        : new Decimal(remote.cumExecQty);
    const state =
      terminal.includes(remote.orderStatus) &&
      (!expected || !applied.eq(expected))
        ? "RECONCILING"
        : remote.orderStatus;
    if (state === "RECONCILING") ready = false;
    await db.query(
      "UPDATE orders SET state=$1,exchange_id=$2,updated_at=now() WHERE tenant_id=$3 AND id=$4",
      [state, remote.orderId, tid, order.id],
    );
    await orderEvent(
      db,
      tid,
      order.id,
      "remote:" + state + ":" + applied.toFixed(),
      state,
      { appliedQuantity: applied.toFixed() },
    );
  }
  if (ready)
    await db.query(
      "UPDATE exchange_connections SET reconciled_at=$1 WHERE tenant_id=$2 AND id=$3",
      [new Date(now), tid, connectionId],
    );
  return ready;
}
