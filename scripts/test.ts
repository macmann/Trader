import { randomUUID } from "node:crypto";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { migrate } from "./migrations.ts";
import { configureLocalRole } from "./roles.ts";
const name = "trader_test_" + randomUUID().replaceAll("-", "");
const adminUrl = new URL(process.env.DATABASE_ADMIN_URL!),
  appUrl = new URL(process.env.DATABASE_URL!);
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
const temp = await mkdtemp(join(tmpdir(), "trader-tests-"));
let created = false;
try {
  await admin.query(`CREATE DATABASE ${name}`);
  created = true;
  adminUrl.pathname = "/" + name;
  appUrl.pathname = "/" + name;
  const db = new pg.Client({ connectionString: adminUrl.toString() });
  await db.connect();
  try {
    await db.query(await readFile("infra/schema.sql", "utf8"));
    await migrate(db);
    await configureLocalRole(db);
  } finally {
    await db.end();
  }
  const tests = (await readdir("tests"))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => "tests/" + f);
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--use-env-proxy", "--import", "tsx", "--test", ...tests],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          NODE_ENV: "test",
          DATABASE_URL: appUrl.toString(),
          DATABASE_ADMIN_URL: adminUrl.toString(),
          TEST_MAIL_OUTBOX_PATH: join(temp, "mail.jsonl"),
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (c) => resolve(c ?? 1));
  });
  process.exitCode = code;
} finally {
  if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
  await rm(temp, { recursive: true, force: true });
}
