import type pg from "pg";
import { Decimal } from "decimal.js";
import { botConfig } from "../../../packages/core/src/index.ts";
const add = (a: number, b: number) => new Decimal(a).plus(b).toNumber();
import { portfolioLimits } from "../../../packages/trading/src/index.ts";
export const terminalStates = [
  "Filled",
  "Cancelled",
  "Rejected",
  "Deactivated",
  "PartiallyFilledCanceled",
  "FILLED",
  "CANCELLED",
  "REJECTED",
];
export async function lockPortfolio(db: pg.PoolClient, tenantId: string) {
  await db.query("SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE", [
    tenantId,
  ]);
}
export async function portfolioSnapshot(db: pg.PoolClient, tenantId: string) {
  const saved = (
    await db.query("SELECT config FROM portfolio_limits WHERE tenant_id=$1", [
      tenantId,
    ])
  ).rows[0];
  const limits = portfolioLimits.parse(saved?.config ?? {});
  const bots = (
    await db.query(
      "SELECT b.id,b.connection_id,b.symbol,b.config,b.status,COALESCE(p.cost,0) AS cost,COALESCE(p.quantity,0) AS quantity FROM bots b LEFT JOIN positions p ON p.bot_id=b.id AND p.tenant_id=b.tenant_id WHERE b.tenant_id=$1",
      [tenantId],
    )
  ).rows;
  const pending = (
    await db.query(
      "SELECT o.bot_id,o.side,o.requested_notional,b.connection_id,o.symbol FROM orders o JOIN bots b ON b.id=o.bot_id AND b.tenant_id=o.tenant_id WHERE o.tenant_id=$1 AND NOT (o.state=ANY($2::text[]))",
      [tenantId, terminalStates],
    )
  ).rows;
  const connections: Record<
      string,
      { allocated: number; exposure: number; pending: number }
    > = {},
    symbols: Record<
      string,
      { allocated: number; exposure: number; pending: number }
    > = {};
  let allocated = 0,
    exposure = 0,
    reserved = 0;
  const active = new Set<string>();
  for (const b of bots) {
    const c = (connections[b.connection_id] ??= {
        allocated: 0,
        exposure: 0,
        pending: 0,
      }),
      s = (symbols[b.symbol] ??= { allocated: 0, exposure: 0, pending: 0 });
    if (b.status !== "ARCHIVED") {
      const capital = botConfig.parse(b.config).capital;
      allocated = add(allocated, capital);
      c.allocated = add(c.allocated, capital);
      s.allocated = add(s.allocated, capital);
    }
    const cost = Number(b.cost);
    exposure = add(exposure, cost);
    c.exposure = add(c.exposure, cost);
    s.exposure = add(s.exposure, cost);
    if (Number(b.quantity) > 0) active.add(b.id);
  }
  for (const o of pending) {
    if (o.side !== "Buy") continue;
    const notional = Number(o.requested_notional ?? 0);
    reserved = add(reserved, notional);
    const c = (connections[o.connection_id] ??= {
        allocated: 0,
        exposure: 0,
        pending: 0,
      }),
      s = (symbols[o.symbol] ??= { allocated: 0, exposure: 0, pending: 0 });
    c.pending = add(c.pending, notional);
    s.pending = add(s.pending, notional);
    active.add(o.bot_id);
  }
  return {
    limits,
    allocated,
    exposure,
    reserved,
    openPositions: active.size,
    unknownPending: pending.some((o) => o.requested_notional === null),
    connections,
    symbols,
    bots,
    pendingCount: pending.length,
    note: "Exposure uses tracked cost basis plus full pending-buy reservations, not live marked-to-market equity.",
  };
}
export function allocationReasons(
  snapshot: Awaited<ReturnType<typeof portfolioSnapshot>>,
  capital: number,
  connectionId: string,
  symbol: string,
) {
  const r: string[] = [];
  if (snapshot.allocated + capital > snapshot.limits.maxTotalAllocation)
    r.push("TOTAL_ALLOCATION_LIMIT");
  if (
    (snapshot.connections[connectionId]?.allocated ?? 0) + capital >
    snapshot.limits.maxConnectionAllocation
  )
    r.push("CONNECTION_ALLOCATION_LIMIT");
  if (
    (snapshot.symbols[symbol]?.allocated ?? 0) + capital >
    snapshot.limits.maxSymbolAllocation
  )
    r.push("SYMBOL_ALLOCATION_LIMIT");
  return r;
}
