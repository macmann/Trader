import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import pg from "pg";
import { migrate } from "../scripts/migrations.ts";
import { configureLocalRole } from "../scripts/roles.ts";
test("first-run setup and encrypted operator settings on an isolated installation", async () => {
  const name = "installation_test_" + randomBytes(8).toString("hex");
  const admin = new pg.Client({
    connectionString: process.env.DATABASE_ADMIN_URL,
  });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const adminUrl = new URL(process.env.DATABASE_ADMIN_URL!);
    adminUrl.pathname = "/" + name;
    const appUrl = new URL(process.env.DATABASE_URL!);
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
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "tests/installation-fixture.ts"],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            NODE_ENV: "test",
            DATABASE_URL: appUrl.toString(),
            DATABASE_ADMIN_URL: adminUrl.toString(),
            MAIL_MODE: "disabled",
            INSTALLATION_SETUP_ENABLED: "true",
          },
        },
      );
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
    assert.equal(code, 0, "isolated installation acceptance failed");
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
