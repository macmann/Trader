import { readFile } from "node:fs/promises";
import pg from "pg";
import { migrate } from "../../../scripts/migrations.ts";
const db = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await db.connect();
try {
  await db.query(
    await readFile(
      new URL("../../../infra/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  await migrate(db);
} finally {
  await db.end();
}
console.log("Database migrations applied");
