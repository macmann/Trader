import pg from "pg";
if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL)
  throw Error(
    "DATABASE_URL is required; production containers must use the bootstrap entrypoint",
  );
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});
export async function tenant<T>(
  id: string,
  fn: (db: pg.PoolClient) => Promise<T>,
  sessionLock?: string,
): Promise<T> {
  const db = await pool.connect();
  let locked = false;
  try {
    if (sessionLock) {
      locked = (
        await db.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
          [sessionLock],
        )
      ).rows[0].locked;
      if (!locked) return undefined as T;
    }
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.tenant_id',$1,true)", [id]);
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    if (locked)
      await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        sessionLock,
      ]);
    db.release();
  }
}
export async function audit(
  db: pg.PoolClient,
  tenantId: string,
  action: string,
  data: unknown = {},
) {
  await db.query(
    "INSERT INTO audit_logs(tenant_id,action,data) VALUES($1,$2,$3)",
    [tenantId, action, JSON.stringify(data)],
  );
}
