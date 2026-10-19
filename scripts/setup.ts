import { access, writeFile, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { migrate } from "./migrations.ts";
import { configureLocalRole } from "./roles.ts";
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
await migrate(admin);
await configureLocalRole(admin);
await admin.end();
console.log(
  "Local database and restricted application role ready. Existing .env preserved.",
);
