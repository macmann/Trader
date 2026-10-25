import type pg from "pg";
import { Decimal } from "decimal.js";
import { audit } from "../../api/src/db.ts";
export class InventoryError extends Error {
  constructor(
    readonly details: {
      asset: string;
      actual: string;
      expected: string;
      managed: string;
      external: string;
      difference: string;
    },
  ) {
    super("UNEXPECTED_ACCOUNT_POSITION");
  }
}
export function assetTotal(balances: any, asset: string) {
  if (!Array.isArray(balances?.list?.[0]?.coin))
    throw Error("ACCOUNT_BALANCE_INVALID");
  const matches = balances.list[0].coin.filter(
    (coin: any) => coin.coin === asset,
  );
  if (matches.length > 1) throw Error("ACCOUNT_BALANCE_INVALID");
  if (
    matches.length &&
    (matches[0].walletBalance === undefined ||
      matches[0].walletBalance === null ||
      matches[0].walletBalance === "")
  )
    throw Error("ACCOUNT_BALANCE_INVALID");
  const total = new Decimal(matches[0]?.walletBalance ?? 0);
  if (!total.isFinite() || total.lt(0)) throw Error("ACCOUNT_BALANCE_INVALID");
  return total;
}
export async function managedAssets(
  db: pg.PoolClient,
  tid: string,
  connectionId: string,
) {
  return (
    await db.query(
      "SELECT replace(b.symbol,'USDT','') AS asset,COALESCE(sum(p.quantity),0) AS quantity FROM bots b LEFT JOIN positions p ON p.bot_id=b.id AND p.tenant_id=b.tenant_id WHERE b.connection_id=$1 AND b.tenant_id=$2 AND b.market_type='SPOT' GROUP BY b.symbol",
      [connectionId, tid],
    )
  ).rows;
}
export async function checkInventory(
  db: pg.PoolClient,
  tid: string,
  connectionId: string,
  asset: string,
  actual: Decimal,
  allowAdoption = false,
) {
  const managed = (await managedAssets(db, tid, connectionId)).find(
    (row) => row.asset === asset,
  );
  const quantity = new Decimal(managed?.quantity ?? 0);
  if (!quantity.isFinite() || quantity.lt(0))
    throw Error("ACCOUNT_POSITION_INVALID");
  let baseline = (
    await db.query(
      "SELECT external_quantity FROM connection_inventory WHERE tenant_id=$1 AND connection_id=$2 AND asset=$3",
      [tid, connectionId, asset],
    )
  ).rows[0];
  if (!baseline) {
    const surplus = actual.minus(quantity);
    // An existing managed ledger may only adopt the prior strict zero-external assumption.
    if (surplus.abs().gt("0.000001") && (!allowAdoption || quantity.gt(0)))
      throw Error("INVENTORY_BASELINE_REVIEW_REQUIRED");
    if (surplus.lt("-0.000001"))
      throw Error("INVENTORY_BASELINE_REVIEW_REQUIRED");
    const external =
      allowAdoption && quantity.isZero()
        ? Decimal.max(surplus, 0)
        : new Decimal(0);
    await db.query(
      "INSERT INTO connection_inventory(tenant_id,connection_id,asset,external_quantity,last_total) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [tid, connectionId, asset, external.toFixed(), actual.toFixed()],
    );
    baseline = (
      await db.query(
        "SELECT external_quantity FROM connection_inventory WHERE tenant_id=$1 AND connection_id=$2 AND asset=$3",
        [tid, connectionId, asset],
      )
    ).rows[0];
    await audit(db, tid, "ACCOUNT_INVENTORY_BASELINED", {
      connectionId,
      asset,
      externalQuantity: baseline.external_quantity,
    });
  }
  const external = new Decimal(baseline.external_quantity);
  if (!external.isFinite() || external.lt(0))
    throw Error("ACCOUNT_POSITION_INVALID");
  const expected = external.plus(quantity),
    difference = actual.minus(expected);
  if (difference.abs().gt("0.000001"))
    throw new InventoryError({
      asset,
      actual: actual.toFixed(),
      expected: expected.toFixed(),
      managed: quantity.toFixed(),
      external: external.toFixed(),
      difference: difference.toFixed(),
    });
  await db.query(
    "UPDATE connection_inventory SET last_total=$1,last_checked_at=now() WHERE tenant_id=$2 AND connection_id=$3 AND asset=$4",
    [actual.toFixed(), tid, connectionId, asset],
  );
  return { managed: quantity, external };
}
