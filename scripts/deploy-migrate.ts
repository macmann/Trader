import pg from "pg";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { migrate } from "./migrations.ts";
import { configureDeploymentRole } from "./roles.ts";
const db = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
try {
  await db.connect();
  await db.query("SELECT pg_advisory_lock(72723250)");
  try {
    await db.query(
      await readFile(new URL("../infra/schema.sql", import.meta.url), "utf8"),
    );
    await migrate(db);
    if (process.env.BUNDLED_DATABASE === "true") {
      const password = (
        await readFile("/run/app-secrets/database-password", "utf8")
      ).trim();
      const setup = (
        await readFile("/run/app-secrets/setup-token", "utf8")
      ).trim();
      if (!/^[a-f0-9]{64}$/.test(password) || !/^[a-f0-9]{64}$/.test(setup))
        throw Error("Invalid installation credentials");
      const exists = await db.query(
        "SELECT 1 FROM pg_roles WHERE rolname='trader_app'",
      );
      if (!exists.rowCount)
        await db.query(
          "CREATE ROLE trader_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD " +
            db.escapeLiteral(password),
        );
      await db.query(
        "INSERT INTO installation_setup(token_hash) SELECT $1 WHERE NOT EXISTS(SELECT FROM users) AND NOT EXISTS(SELECT FROM platform_operators) ON CONFLICT DO NOTHING",
        [createHash("sha256").update(setup).digest("hex")],
      );
    }
    await configureDeploymentRole(db, process.env.APP_DATABASE_USER ?? "");
  } finally {
    await db.query("SELECT pg_advisory_unlock(72723250)");
  }
  console.log(
    "Deployment schema, migrations and restricted runtime grants ready",
  );
} catch {
  console.error(
    "Deployment initialization failed; check database access, migration checksums and restricted runtime role configuration",
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
