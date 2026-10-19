import pg from "pg";
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export async function tenant<T>(
  id: string,
  fn: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.tenant_id',$1,true)", [id]);
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
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
