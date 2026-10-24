import type pg from "pg";
export async function configureLocalRole(db: pg.Client) {
  await db.query(
    "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='trader_app') THEN CREATE ROLE trader_app LOGIN PASSWORD 'local-app-development-only' NOSUPERUSER NOBYPASSRLS; END IF; END $$",
  );
  await db.query(
    "GRANT USAGE ON SCHEMA public TO trader_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO trader_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO trader_app; REVOKE UPDATE,DELETE ON audit_logs,order_events,trade_cycles,marketplace_versions,marketplace_evidence,research_runs,usage_records,billing_events FROM trader_app; REVOKE INSERT,UPDATE,DELETE ON platform_controls,schema_migrations,platform_operators,installation_setup FROM trader_app; REVOKE SELECT ON installation_setup FROM trader_app; GRANT EXECUTE ON FUNCTION claim_installation(text,uuid,text,text,uuid) TO trader_app; REVOKE UPDATE,DELETE ON custom_strategies,ai_strategy_decisions FROM trader_app; REVOKE UPDATE,DELETE ON connection_inventory FROM trader_app; GRANT UPDATE(last_total,last_checked_at) ON connection_inventory TO trader_app",
  );
}

export async function configureDeploymentRole(db: pg.Client, role: string) {
  if (!role || Buffer.byteLength(role) > 63 || role.includes("\0"))
    throw Error("APP_DATABASE_USER must name an existing restricted role");
  const result = await db.query(
    "SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname=$1",
    [role],
  );
  const account = result.rows[0];
  if (
    !account ||
    !account.rolcanlogin ||
    account.rolsuper ||
    account.rolbypassrls ||
    account.rolcreaterole ||
    account.rolcreatedb
  )
    throw Error("Runtime database role must be a restricted login");
  const identity = await db.query("SELECT current_user = $1 AS same", [role]);
  if (identity.rows[0].same)
    throw Error("Migration and runtime roles must differ");
  const inherited = await db.query(
    "SELECT 1 FROM pg_roles WHERE pg_has_role($1,oid,'MEMBER') AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolname=current_user) UNION ALL SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND pg_has_role($1,relowner,'MEMBER') LIMIT 1",
    [role],
  );
  if (inherited.rowCount)
    throw Error(
      "Runtime role must not inherit privileged roles or own schema objects",
    );
  const identifier = db.escapeIdentifier(role);
  await db.query(
    `GRANT USAGE ON SCHEMA public TO ${identifier}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${identifier}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${identifier}; REVOKE UPDATE,DELETE ON audit_logs,order_events,trade_cycles,marketplace_versions,marketplace_evidence,research_runs,usage_records,billing_events FROM ${identifier}; REVOKE INSERT,UPDATE,DELETE ON platform_controls,schema_migrations,platform_operators,installation_setup FROM ${identifier}; REVOKE SELECT ON installation_setup FROM ${identifier}; GRANT EXECUTE ON FUNCTION claim_installation(text,uuid,text,text,uuid) TO ${identifier}; REVOKE UPDATE,DELETE ON custom_strategies,ai_strategy_decisions FROM ${identifier}; REVOKE UPDATE,DELETE ON connection_inventory FROM ${identifier}; GRANT UPDATE(last_total,last_checked_at) ON connection_inventory TO ${identifier}`,
  );
}
