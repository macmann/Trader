import { access, writeFile, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "pg";
try {
  await access(".env");
} catch {
  const example = await readFile(".env.example", "utf8");
  await writeFile(
    ".env",
    example.replace(
      "APP_ENCRYPTION_KEY=",
      "APP_ENCRYPTION_KEY=" + randomBytes(32).toString("hex"),
    ),
    { mode: 0o600, flag: "wx" },
  );
}
execFileSync(
  "docker",
  ["compose", "-f", "infra/compose.yaml", "up", "-d", "--wait"],
  { stdio: "inherit" },
);
process.loadEnvFile(".env");
const admin = new pg.Client({
  connectionString: process.env.DATABASE_ADMIN_URL,
});
await admin.connect();
await admin.query(await readFile("infra/schema.sql", "utf8"));
await admin.query(
  "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='trader_app') THEN CREATE ROLE trader_app LOGIN PASSWORD 'local-app-development-only' NOSUPERUSER NOBYPASSRLS; END IF; END $$",
);
await admin.query(
  "GRANT USAGE ON SCHEMA public TO trader_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO trader_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO trader_app; REVOKE UPDATE,DELETE ON audit_logs FROM trader_app; REVOKE INSERT,UPDATE,DELETE ON platform_controls FROM trader_app",
);
await admin.end();
console.log(
  "Local database and restricted application role ready. Existing .env preserved.",
);
