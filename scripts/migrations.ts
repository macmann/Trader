import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import type pg from "pg";
export async function migrate(db: pg.Client) {
  await db.query("SELECT pg_advisory_lock(72723249)");
  try {
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const dir = new URL("../infra/migrations/", import.meta.url);
    for (const name of (await readdir(dir))
      .filter((v) => v.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(new URL(name, dir), "utf8"),
        checksum = createHash("sha256").update(sql).digest("hex");
      const previous = (
        await db.query("SELECT checksum FROM schema_migrations WHERE name=$1", [
          name,
        ])
      ).rows[0];
      if (previous) {
        if (previous.checksum !== checksum)
          throw Error(`Migration checksum mismatch: ${name}`);
        continue;
      }
      await db.query("BEGIN");
      try {
        await db.query(sql);
        await db.query(
          "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
          [name, checksum],
        );
        await db.query("COMMIT");
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await db.query("SELECT pg_advisory_unlock(72723249)");
  }
}
