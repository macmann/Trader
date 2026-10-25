import type pg from "pg";
import { pool } from "./db.ts";
export const plans = {
  FREE: {
    bots: 1,
    connections: 1,
    backtests: 10,
    paper: 1,
    ai: 20,
    marketplace: 5,
  },
  BASIC: {
    bots: 3,
    connections: 3,
    backtests: 100,
    paper: 3,
    ai: 500,
    marketplace: 20,
  },
  PRO: {
    bots: 10,
    connections: 10,
    backtests: 1000,
    paper: 10,
    ai: 5000,
    marketplace: 100,
  },
} as const;
export async function userContext<T>(
  uid: string,
  fn: (db: pg.PoolClient) => Promise<T>,
) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.user_id',$1,true)", [uid]);
    const v = await fn(db);
    await db.query("COMMIT");
    return v;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export async function entitlements(db: pg.PoolClient, tid: string) {
  const s = (
    await db.query("SELECT * FROM subscriptions WHERE tenant_id=$1", [tid])
  ).rows[0];
  const unlimited = !!(
    await db.query(
      "SELECT 1 FROM platform_owner o JOIN workspaces w ON w.owner_id=o.user_id WHERE w.id=$1 AND w.kind='PERSONAL'",
      [tid],
    )
  ).rowCount;
  const effective =
    s?.admin_plan_override ??
    (s?.status === "ACTIVE" &&
    (!s.period_end || s.period_end.getTime() > Date.now())
      ? (s.plan as keyof typeof plans)
      : "FREE");
  return {
    plan: unlimited ? "UNLIMITED" : effective,
    unlimited,
    adminManaged: !!s?.admin_plan_override,
    subscription: s ?? null,
    limits: unlimited
      ? (Object.fromEntries(
          Object.keys(plans.FREE).map((key) => [key, Number.MAX_SAFE_INTEGER]),
        ) as Record<keyof typeof plans.FREE, number>)
      : (plans[effective as keyof typeof plans] ?? plans.FREE),
  };
}
export async function consume(
  db: pg.PoolClient,
  tid: string,
  metric: "backtests" | "ai",
  ref: string,
) {
  await db.query("SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE", [
    tid,
  ]);
  const e = await entitlements(db, tid),
    used = Number(
      (
        await db.query(
          "SELECT COALESCE(sum(units),0) AS n FROM usage_records WHERE tenant_id=$1 AND metric=$2 AND created_at>=date_trunc('month',now())",
          [tid, metric],
        )
      ).rows[0].n,
    );
  if (!e.unlimited && used >= e.limits[metric])
    throw Object.assign(Error("MONTHLY_QUOTA_EXCEEDED"), { statusCode: 429 });
  await db.query(
    "INSERT INTO usage_records(tenant_id,metric,units,reference) VALUES($1,$2,1,$3) ON CONFLICT DO NOTHING",
    [tid, metric, ref],
  );
}
export function allowed(role: string, method: string, path: string) {
  if (
    ["GET", "HEAD", "OPTIONS"].includes(method) ||
    path.startsWith("/api/auth/")
  )
    return true;
  if (/^\/api\/notifications\/[^/]+\/read$/.test(path)) return true;
  if (role === "OWNER") return true;
  if (
    path.startsWith("/api/workspace") ||
    path.startsWith("/api/notifications/settings") ||
    path.startsWith("/api/connections") ||
    path === "/api/portfolio/limits" ||
    path.startsWith("/api/marketplace/listings")
  )
    return role === "ADMIN";
  return role === "ADMIN" || role === "TRADER";
}
