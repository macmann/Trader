import type pg from "pg";
export async function configureLocalRole(db: pg.Client) {
  await db.query(
    "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='trader_app') THEN CREATE ROLE trader_app LOGIN PASSWORD 'local-app-development-only' NOSUPERUSER NOBYPASSRLS; END IF; END $$",
  );
  await db.query(
    "GRANT USAGE ON SCHEMA public TO trader_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO trader_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO trader_app; REVOKE UPDATE,DELETE ON audit_logs,order_events,trade_cycles,marketplace_versions,marketplace_evidence,research_runs,usage_records,billing_events FROM trader_app; REVOKE INSERT,UPDATE,DELETE ON platform_controls,schema_migrations FROM trader_app",
  );
}

export async function configureDeploymentRole(db: pg.Client, password: string) {
  if (password.length < 32 || password.includes("\0"))
    throw Error("APP_DATABASE_PASSWORD must contain at least 32 characters");
  await db.query(
    "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='trader_app') THEN CREATE ROLE trader_app NOSUPERUSER NOBYPASSRLS; END IF; END $$",
  );
  await db.query(
    "ALTER ROLE trader_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD " +
      db.escapeLiteral(password),
  );
  await configureLocalRole(db);
}
