import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
let manifest: Promise<{ name: string; checksum: string }[]> | undefined;
function expectedMigrations() {
  return (manifest ??= (async () => {
    const directory = new URL("../infra/migrations/", import.meta.url);
    return Promise.all(
      (await readdir(directory))
        .filter((name) => name.endsWith(".sql"))
        .sort()
        .map(async (name) => ({
          name,
          checksum: createHash("sha256")
            .update(await readFile(new URL(name, directory)))
            .digest("hex"),
        })),
    );
  })());
}
export async function schemaReady(db: Pick<pg.Client, "query">) {
  const expected = await expectedMigrations();
  const rows = (
    await db.query(
      "SELECT name,checksum FROM schema_migrations WHERE name=ANY($1::text[])",
      [expected.map((v) => v.name)],
    )
  ).rows;
  if (
    rows.length !== expected.length ||
    !expected.every((v) =>
      rows.some((r) => r.name === v.name && r.checksum === v.checksum),
    )
  )
    return false;
  const critical = (
    await db.query(
      "SELECT to_regclass('users') IS NOT NULL AND to_regclass('workspaces') IS NOT NULL AND to_regclass('platform_settings') IS NOT NULL AND to_regclass('platform_operators') IS NOT NULL AS ready",
    )
  ).rows[0];
  return critical.ready === true;
}
export async function waitForDatabase(options: {
  connectionString: string | undefined;
  service: string;
  requireSchema?: boolean;
  timeoutMs?: number;
  retryMs?: number;
}) {
  if (!options.connectionString)
    throw Error("DATABASE_STARTUP_CONFIGURATION_MISSING");
  const timeout = options.timeoutMs ?? 60000;
  const deadline = performance.now() + timeout;
  let notified = false;
  while (performance.now() < deadline) {
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
    const db = new pg.Client({
      connectionString: options.connectionString,
      connectionTimeoutMillis: Math.min(2000, remaining),
      query_timeout: Math.min(2000, remaining),
    });
    try {
      await db.connect();
      await db.query("SELECT 1");
      if (!options.requireSchema || (await schemaReady(db))) return;
    } catch {
      // Never include connection URLs, driver messages or passwords in startup logs.
    } finally {
      await db.end().catch(() => {});
    }
    if (!notified) {
      console.log(
        JSON.stringify({
          event: "DATABASE_STARTUP_WAITING",
          service: options.service,
        }),
      );
      notified = true;
    }
    const pause = Math.min(
      options.retryMs ?? 1000,
      deadline - performance.now(),
    );
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
  }
  throw Error(
    `DATABASE_STARTUP_TIMEOUT: ${options.service} database/schema not ready within ${timeout}ms`,
  );
}
