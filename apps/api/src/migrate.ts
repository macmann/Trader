import { readFile } from "node:fs/promises";
import pg from "pg";
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL,
});
await pool.query(
  await readFile(new URL("../../../infra/schema.sql", import.meta.url), "utf8"),
);
await pool.end();
console.log("Database schema applied");
