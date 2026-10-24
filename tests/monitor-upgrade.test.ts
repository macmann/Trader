import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { migrate } from "../scripts/migrations.ts";
test("monitoring upgrade preserves legacy bots, orders and fills and does not invent old run attribution", async () => {
  const root = new pg.Client({
    connectionString: process.env.DATABASE_ADMIN_URL,
  });
  await root.connect();
  const name = "monitor_upgrade_" + randomUUID().replaceAll("-", "");
  await root.query("CREATE DATABASE " + name);
  const url = new URL(process.env.DATABASE_ADMIN_URL!);
  url.pathname = "/" + name;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    await db.query(await readFile("infra/schema.sql", "utf8"));
    await db.query(
      "CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const file of (await readdir("infra/migrations"))
      .filter((v) => v.endsWith(".sql") && v < "008")
      .sort()) {
      const sql = await readFile("infra/migrations/" + file, "utf8");
      await db.query(sql);
      await db.query(
        "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
        [file, createHash("sha256").update(sql).digest("hex")],
      );
    }
    const uid = randomUUID(),
      tid = randomUUID(),
      cid = randomUUID(),
      bid = randomUUID(),
      oid = randomUUID();
    await db.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,$2,'fixture')",
      [uid, uid + "@example.com"],
    );
    await db.query("INSERT INTO workspaces(id,owner_id) VALUES($1,$2)", [
      tid,
      uid,
    ]);
    await db.query(
      "INSERT INTO exchange_connections(id,tenant_id,name,environment,credentials,status,permissions) VALUES($1,$2,'Legacy','TESTNET','fixture','CONNECTED','{}')",
      [cid, tid],
    );
    await db.query(
      "INSERT INTO bots(id,tenant_id,connection_id,name,status,config) VALUES($1,$2,$3,'Legacy','RUNNING','{}')",
      [bid, tid, cid],
    );
    await db.query(
      "INSERT INTO orders(id,tenant_id,bot_id,client_id,side,quantity,state) VALUES($1,$2,$3,$4,'Buy',.001,'Filled')",
      [oid, tid, bid, oid],
    );
    await db.query(
      "INSERT INTO executions(id,tenant_id,order_id,quantity,price,fee,executed_at) VALUES($1,$2,$3,.001,50000,.05,now())",
      [randomUUID(), tid, oid],
    );
    await migrate(db);
    await migrate(db);
    assert.equal(
      (await db.query("SELECT status FROM bots WHERE id=$1", [bid])).rows[0]
        .status,
      "RUNNING",
    );
    assert.equal(
      (await db.query("SELECT * FROM executions WHERE order_id=$1", [oid]))
        .rowCount,
      1,
    );
    assert.equal(
      (await db.query("SELECT run_id FROM orders WHERE id=$1", [oid])).rows[0]
        .run_id,
      null,
    );
    const runs = await db.query("SELECT * FROM bot_runs WHERE bot_id=$1", [
      bid,
    ]);
    assert.equal(runs.rowCount, 1);
    assert.equal(runs.rows[0].origin, "MONITORING_ADOPTED");
  } finally {
    await db.end();
    await root.query("DROP DATABASE " + name + " WITH (FORCE)");
    await root.end();
  }
});
