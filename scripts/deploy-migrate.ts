import pg from "pg";
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
