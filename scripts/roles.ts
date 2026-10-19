import type pg from "pg";
export async function configureLocalRole(db: pg.Client) {
  await db.query(
    "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='trader_app') THEN CREATE ROLE trader_app LOGIN PASSWORD 'local-app-development-only' NOSUPERUSER NOBYPASSRLS; END IF; END $$",
  );
  await db.query(
    "GRANT USAGE ON SCHEMA public TO trader_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO trader_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO trader_app; REVOKE UPDATE,DELETE ON audit_logs FROM trader_app; REVOKE INSERT,UPDATE,DELETE ON platform_controls,schema_migrations FROM trader_app",
  );
}
