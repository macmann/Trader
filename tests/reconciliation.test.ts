import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { pool, tenant } from "../apps/api/src/db.ts";
import { BybitAdapter } from "../packages/core/src/index.ts";
import { reconcile } from "../apps/worker/src/engine.ts";
const admin = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
const uid = randomUUID(),
  tid = randomUUID(),
  cid = randomUUID(),
  bid = randomUUID(),
  oid = randomUUID(),
  clientId = randomUUID();
after(async () => {
  for (const table of [
    "executions",
    "orders",
    "positions",
    "bots",
    "exchange_connections",
    "audit_logs",
  ])
    await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tid]);
  await admin.query("DELETE FROM workspaces WHERE id=$1", [tid]);
  await admin.query("DELETE FROM users WHERE id=$1", [uid]);
  await admin.end();
  await pool.end();
});
test("reconciliation applies exchange fills exactly once across restart and handles partial sells", async () => {
  await admin.query(
    "INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",
    [uid, `${uid}@example.com`, "fixture"],
  );
  await admin.query("INSERT INTO workspaces(id,owner_id) VALUES($1,$2)", [
    tid,
    uid,
  ]);
  await tenant(tid, async (db) => {
    await db.query(
      "INSERT INTO exchange_connections(id,tenant_id,name,environment,credentials,status,permissions) VALUES($1,$2,'Fixture','TESTNET','none','CONNECTED','{}')",
      [cid, tid],
    );
    await db.query(
      "INSERT INTO bots(id,tenant_id,connection_id,name,config) VALUES($1,$2,$3,'Fixture','{}')",
      [bid, tid, cid],
    );
    await db.query("INSERT INTO positions(bot_id,tenant_id) VALUES($1,$2)", [
      bid,
      tid,
    ]);
    await db.query(
      "INSERT INTO orders(id,tenant_id,bot_id,client_id,side,quantity,state) VALUES($1,$2,$3,$4,'Buy',1,'SUBMITTED')",
      [oid, tid, bid, clientId],
    );
  });
  const adapter = new BybitAdapter("TESTNET");
  const fill = {
    execId: randomUUID(),
    orderLinkId: clientId,
    execQty: "1",
    execPrice: "100",
    execFee: "0.1",
    feeCurrency: "USDT",
    execTime: String(Date.now()),
  };
  let fills = [fill];
  adapter.getOpenOrders = async () => ({ list: [] });
  adapter.getExecutions = async () => ({ list: fills });
  adapter.getOrder = async () => ({
    list: [{ orderStatus: "Filled", orderId: "remote-id" }],
  });
  await tenant(tid, (db) => reconcile(db, tid, cid, adapter));
  await tenant(tid, (db) => reconcile(db, tid, cid, adapter));
  let position = await tenant(
    tid,
    async (db) =>
      (await db.query("SELECT * FROM positions WHERE bot_id=$1", [bid]))
        .rows[0],
  );
  assert.equal(Number(position.quantity), 1);
  assert.equal(Number(position.cost), 100);
  assert.equal(Number(position.fees), 0.1);
  const sellId = randomUUID(),
    sellClient = randomUUID();
  await tenant(tid, async (db) => {
    await db.query(
      "INSERT INTO orders(id,tenant_id,bot_id,client_id,side,quantity,state) VALUES($1,$2,$3,$4,'Sell',0.5,'SUBMITTED')",
      [sellId, tid, bid, sellClient],
    );
  });
  fills = [
    fill,
    {
      ...fill,
      execId: randomUUID(),
      orderLinkId: sellClient,
      execQty: "0.5",
      execPrice: "110",
      execFee: "0.055",
    },
  ];
  await tenant(tid, (db) => reconcile(db, tid, cid, adapter));
  await tenant(tid, (db) => reconcile(db, tid, cid, adapter));
  position = await tenant(
    tid,
    async (db) =>
      (await db.query("SELECT * FROM positions WHERE bot_id=$1", [bid]))
        .rows[0],
  );
  assert.equal(Number(position.quantity), 0.5);
  assert.equal(Number(position.cost), 50);
  assert.equal(Number(position.realized_pnl), 5);
  assert.equal(Number(position.fees), 0.155);

  const ethBot = randomUUID(),
    ethOrder = randomUUID(),
    ethClient = randomUUID();
  await tenant(tid, async (db) => {
    await db.query(
      "INSERT INTO bots(id,tenant_id,connection_id,name,symbol,config) VALUES($1,$2,$3,'ETH fixture','ETHUSDT','{}')",
      [ethBot, tid, cid],
    );
    await db.query("INSERT INTO positions(bot_id,tenant_id) VALUES($1,$2)", [
      ethBot,
      tid,
    ]);
    await db.query(
      "INSERT INTO orders(id,tenant_id,bot_id,client_id,side,quantity,state,symbol,requested_notional) VALUES($1,$2,$3,$4,'Buy',2,'SUBMITTED','ETHUSDT',200)",
      [ethOrder, tid, ethBot, ethClient],
    );
  });
  fills = [
    ...fills,
    {
      ...fill,
      execId: randomUUID(),
      orderLinkId: ethClient,
      execQty: "1",
      execPrice: "100",
      execFee: "0.1",
    },
    {
      ...fill,
      execId: randomUUID(),
      orderLinkId: ethClient,
      execQty: "1",
      execPrice: "100",
      execFee: "0.1",
    },
  ];
  await tenant(tid, (db) => reconcile(db, tid, cid, adapter));
  await tenant(tid, (db) => reconcile(db, tid, cid, adapter));
  const multi = await tenant(
    tid,
    async (db) =>
      (await db.query("SELECT * FROM positions WHERE bot_id=$1", [ethBot]))
        .rows[0],
  );
  assert.equal(Number(multi.quantity), 2);
  assert.equal(Number(multi.cost), 200);
  assert.equal(
    Number(multi.entry_count),
    1,
    "Partial fills count as one strategy entry",
  );
  const btc = await tenant(
    tid,
    async (db) =>
      (await db.query("SELECT * FROM positions WHERE bot_id=$1", [bid]))
        .rows[0],
  );
  assert.equal(
    Number(btc.quantity),
    0.5,
    "ETH fills never alter the BTC position",
  );
  adapter.getOpenOrders = async () => ({
    list: [{ orderLinkId: "unknown-order" }],
  });
  await assert.rejects(
    tenant(tid, (db) => reconcile(db, tid, cid, adapter)),
    /UNEXPECTED_EXCHANGE_ORDER/,
  );
  adapter.getOpenOrders = async () => ({ list: [] });
  adapter.getExecutions = async () => ({ list: fills, nextPageCursor: "more" });
  await assert.rejects(
    tenant(tid, (db) => reconcile(db, tid, cid, adapter)),
    /PAGINATED_HISTORY/,
  );
});
