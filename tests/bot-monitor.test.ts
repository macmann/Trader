import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import { app } from "../apps/api/src/server.ts";
import { pool, tenant } from "../apps/api/src/db.ts";
import {
  recordObservation,
  failureObservation,
} from "../apps/worker/src/monitoring.ts";
import { botActionEnabled } from "../packages/core/src/bot-actions.ts";
const admin = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL }),
  origin = process.env.APP_ORIGIN!;
after(async () => {
  await app.close();
  await pool.end();
  await admin.end();
});
async function actor() {
  const uid = randomUUID(),
    tid = randomUUID(),
    cid = randomUUID(),
    token = randomUUID(),
    csrf = randomUUID();
  await admin.query(
    "INSERT INTO users(id,email,password_hash,verified) VALUES($1,$2,'fixture',true)",
    [uid, uid + "@example.com"],
  );
  await admin.query("INSERT INTO workspaces(id,owner_id) VALUES($1,$2)", [
    tid,
    uid,
  ]);
  await admin.query("UPDATE subscriptions SET plan='PRO' WHERE tenant_id=$1", [
    tid,
  ]);
  await admin.query(
    "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [createHash("sha256").update(token).digest("hex"), uid, csrf],
  );
  await admin.query(
    "INSERT INTO exchange_connections(id,tenant_id,name,environment,credentials,status,permissions) VALUES($1,$2,'Test fixture','TESTNET','never-expose-credential','CONNECTED','{}')",
    [cid, tid],
  );
  const headers = { origin, cookie: "session=" + token, "x-csrf-token": csrf };
  const created = await app.inject({
    method: "POST",
    url: "/api/bots",
    headers,
    payload: { name: "Monitor fixture", connectionId: cid, config: {} },
  });
  assert.equal(created.statusCode, 201, created.body);
  return { uid, tid, cid, bid: created.json().id, headers };
}
const call = (
  a: Awaited<ReturnType<typeof actor>>,
  path: string,
  method: any = "GET",
) =>
  app.inject({ url: `/api/bots/${a.bid}${path}`, method, headers: a.headers });
test("bot lifecycle is idempotent, records runs and does not reset an already-running bot", async () => {
  const a = await actor();
  const started = await Promise.all([
    call(a, "/start", "POST"),
    call(a, "/start", "POST"),
  ]);
  assert.ok(started.every((r) => r.statusCode === 200));
  assert.equal(
    (await admin.query("SELECT * FROM bot_runs WHERE bot_id=$1", [a.bid]))
      .rowCount,
    1,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT * FROM audit_logs WHERE data->>'id'=$1 AND action='BOT_START'",
        [a.bid],
      )
    ).rowCount,
    1,
  );
  assert.equal((await call(a, "/monitor")).json().actions.start, false);
  await admin.query("UPDATE bots SET status='RUNNING' WHERE id=$1", [a.bid]);
  assert.equal((await call(a, "/start", "POST")).json().status, "RUNNING");
  assert.equal((await call(a, "/pause", "POST")).json().status, "PAUSED");
  await call(a, "/start", "POST");
  assert.equal(
    (await admin.query("SELECT * FROM bot_runs WHERE bot_id=$1", [a.bid]))
      .rowCount,
    1,
  );
  await call(a, "/stop", "POST");
  assert.ok(
    (
      await admin.query("SELECT stopped_at FROM bot_runs WHERE bot_id=$1", [
        a.bid,
      ])
    ).rows[0].stopped_at,
  );
  assert.equal((await call(a, "/pause", "POST")).statusCode, 409);
  await call(a, "/start", "POST");
  assert.equal(
    (await admin.query("SELECT * FROM bot_runs WHERE bot_id=$1", [a.bid]))
      .rowCount,
    2,
  );
  await app.inject({
    method: "POST",
    url: "/api/stop-all",
    headers: a.headers,
  });
  assert.equal(
    (
      await admin.query(
        "SELECT * FROM bot_runs WHERE bot_id=$1 AND stopped_at IS NULL",
        [a.bid],
      )
    ).rowCount,
    0,
  );
  assert.equal(botActionEnabled("RUNNING", "start"), false);
  assert.equal(botActionEnabled("STARTING", "start"), false);
  assert.equal(botActionEnabled("STOPPED", "stop"), false);
  assert.equal(botActionEnabled("RISK_LOCKED", "start"), true);
});
test("monitor returns real ledger state, paginated entries/exits, sessions and safe tenant-scoped diagnostics", async () => {
  const a = await actor(),
    b = await actor();
  await call(a, "/start", "POST");
  const run = (
    await admin.query("SELECT id FROM bot_runs WHERE bot_id=$1", [a.bid])
  ).rows[0].id;
  const buy = randomUUID(),
    sell = randomUUID(),
    partial = randomUUID();
  for (const [id, side, state] of [
    [buy, "Buy", "Filled"],
    [sell, "Sell", "Filled"],
    [partial, "Buy", "PartiallyFilled"],
  ])
    await admin.query(
      "INSERT INTO orders(id,tenant_id,bot_id,client_id,side,quantity,state,raw) VALUES($1,$2,$3,$4,$5,.001,$6,$7)",
      [
        id,
        a.tid,
        a.bid,
        id,
        side,
        state,
        JSON.stringify({ secret: "must-not-be-returned" }),
      ],
    );
  assert.equal(
    (await admin.query("SELECT run_id FROM orders WHERE id=$1", [buy])).rows[0]
      .run_id,
    run,
  );
  const fills = [randomUUID(), randomUUID(), randomUUID()];
  await admin.query(
    "INSERT INTO executions(id,tenant_id,order_id,quantity,price,fee,executed_at,realized_gross,realized_net) VALUES($1,$2,$3,.001,50000,.05,'2026-01-01T00:00:00.000001Z',0,0),($4,$2,$5,.001,51000,.051,'2026-01-01T00:00:00.000002Z',1,.899),($6,$2,$7,.001,50000,.05,'2026-01-01T00:00:00.000003Z',0,0)",
    [fills[0], a.tid, buy, fills[1], sell, fills[2], partial],
  );
  await admin.query(
    "INSERT INTO trade_cycles(id,tenant_id,bot_id,strategy_version,net_pnl,closing_execution_id,closed_at) VALUES($1,$2,$3,'trend-v1.0',.899,$4,now())",
    [randomUUID(), a.tid, a.bid, fills[1]],
  );
  await admin.query(
    "UPDATE positions SET quantity=.001,cost=50,realized_pnl=1,fees=.151 WHERE bot_id=$1",
    [a.bid],
  );
  await recordObservation(a.tid, a.bid, {
    stage: "WAITING_CANDLE",
    reasons: ["NEXT_CLOSED_CANDLE"],
    privateReady: true,
    reconciled: true,
    marketReceivedAt: Date.now(),
    price: 52000,
    priceAt: Date.now(),
  });
  let monitor = await call(a, "/monitor");
  assert.equal(monitor.statusCode, 200, monitor.body);
  let value = monitor.json();
  assert.equal(value.summary.fills, 3);
  assert.equal(value.openOrders.length, 1);
  assert.equal(value.summary.closed_cycles, 1);
  assert.equal(value.summary.wins, 1);
  assert.equal(value.summary.averageEntry, 50000);
  assert.equal(value.summary.unrealizedPnl, 2);
  assert.ok(Math.abs(value.summary.realizedNetPnl - 0.849) < 0.00001);
  assert.ok(!monitor.body.includes("never-expose-credential"));
  assert.ok(!monitor.body.includes("must-not-be-returned"));
  let cursor: string | null = null;
  const ids: string[] = [];
  do {
    const page = await call(
      a,
      `/history?kind=fills&limit=1&runId=${run}${cursor ? "&cursor=" + cursor : ""}`,
    );
    assert.equal(page.statusCode, 200, page.body);
    ids.push(...page.json().items.map((r: any) => r.id));
    cursor = page.json().nextCursor;
  } while (cursor);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids.length, 3);
  const auditIds = ["999999999999999999", "1000000000000000000"];
  for (const auditId of auditIds)
    await admin.query(
      "INSERT INTO audit_logs(id,tenant_id,action,data,created_at) VALUES($1,$2,'MONITOR_TEST',$3,'2026-01-01')",
      [auditId, a.tid, JSON.stringify({ botId: a.bid })],
    );
  const auditCursor = Buffer.from(
    JSON.stringify({
      time: "2026-01-02T00:00:00Z",
      id: "9223372036854775807",
      bot: a.bid,
      kind: "activity",
      run: "",
    }),
  ).toString("base64url");
  const activity = await call(
    a,
    `/history?kind=activity&limit=1&cursor=${auditCursor}`,
  );
  assert.equal(activity.statusCode, 200, activity.body);
  assert.equal(activity.json().items[0].id, auditIds[1]);
  const olderActivity = await call(
    a,
    `/history?kind=activity&limit=1&cursor=${activity.json().nextCursor}`,
  );
  assert.equal(olderActivity.json().items[0].id, auditIds[0]);
  for (const kind of [
    "orders",
    "cycles",
    "signals",
    "activity",
    "events",
    "ai",
    "runs",
  ]) {
    const page = await call(a, `/history?kind=${kind}`);
    assert.equal(page.statusCode, 200, page.body);
  }
  assert.equal(
    (await call(a, "/history?kind=fills&cursor=invalid")).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/bots/${a.bid}/monitor`,
        headers: b.headers,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/bots/${a.bid}/history?kind=fills`,
        headers: b.headers,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await tenant(b.tid, (db) =>
        db.query("SELECT * FROM bot_monitoring WHERE bot_id=$1", [a.bid]),
      )
    ).rowCount,
    0,
  );
  await admin.query(
    "UPDATE bot_monitoring SET price_at=now()-interval '2 minutes',checked_at=now()-interval '3 minutes' WHERE bot_id=$1",
    [a.bid],
  );
  value = (await call(a, "/monitor")).json();
  assert.equal(value.workerFresh, false);
  assert.equal(value.priceFresh, false);
  assert.equal(value.summary.unrealizedPnl, null);
  for (const code of [
    "LEDGER_REBUILD_REQUIRED",
    "UNEXPECTED_EXCHANGE_EXECUTION",
    "RECONCILIATION_WINDOW_EXCEEDED",
  ])
    assert.deepEqual(failureObservation(Error(code)).reasons, [code]);
  const failure = failureObservation(Error("secret-key-never-echo"));
  assert.deepEqual(failure.reasons, ["WORKER_CHECK_FAILED"]);
  await recordObservation(
    a.tid,
    a.bid,
    failureObservation(Error("UNEXPECTED_ACCOUNT_POSITION")),
  );
  await recordObservation(a.tid, a.bid, {
    stage: "RISK_LOCKED",
    reasons: ["BOT_NOT_ACTIVE"],
  });
  value = (await call(a, "/monitor")).json();
  assert.deepEqual(value.monitoring.error_snapshot.reasons, [
    "UNEXPECTED_ACCOUNT_POSITION",
  ]);
  await call(a, "/stop", "POST");
  await call(a, "/start", "POST");
  assert.equal(
    (await call(a, `/history?kind=fills&runId=${run}`)).json().items.length,
    3,
  );
  assert.equal((await call(a, "/history?kind=fills")).json().items.length, 3);
  await admin.query(
    "INSERT INTO workspace_members(tenant_id,user_id,role) VALUES($1,$2,'VIEWER')",
    [a.tid, b.uid],
  );
  await admin.query(
    "UPDATE sessions SET active_tenant_id=$1 WHERE user_id=$2",
    [a.tid, b.uid],
  );
  const viewer = await app.inject({
    url: `/api/bots/${a.bid}/monitor`,
    headers: b.headers,
  });
  assert.equal(viewer.statusCode, 200);
  assert.deepEqual(viewer.json().actions, {
    start: false,
    pause: false,
    stop: false,
  });
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/bots/${a.bid}/start`,
        headers: b.headers,
      })
    ).statusCode,
    403,
  );
  await recordObservation(a.tid, a.bid, {
    stage: "EVALUATING",
    reasons: [],
    reconciled: true,
  });
  assert.equal(
    (await call(a, "/monitor")).json().monitoring.error_snapshot,
    null,
  );
});

test("missing-order recovery requires owner confirmation, reauthentication and tenant-scoped identity", async () => {
  const a = await actor(),
    b = await actor(),
    oid = randomUUID();
  await admin.query(
    "UPDATE exchange_connections SET provider='OKX' WHERE id=$1",
    [a.cid],
  );
  await admin.query(
    "UPDATE bots SET market_type='LINEAR',strategy_version='ai-v1.0',status='RISK_LOCKED' WHERE id=$1",
    [a.bid],
  );
  await admin.query(
    "INSERT INTO orders(id,tenant_id,bot_id,client_id,state,side,quantity,market_type) VALUES($1,$2,$3,$4,'UNKNOWN','Buy',0.09,'LINEAR')",
    [oid, a.tid, a.bid, randomUUID()],
  );
  const send = (
    headers: any,
    payload: any = { orderId: oid, confirmedNoExchangeActivity: true },
  ) =>
    app.inject({
      method: "POST",
      url: `/api/bots/${a.bid}/recover-missing-order`,
      headers,
      payload,
    });
  await admin.query(
    "UPDATE sessions SET reauthenticated_at=now()-interval '10 minutes' WHERE user_id=$1",
    [a.uid],
  );
  assert.equal((await send(a.headers)).statusCode, 403);
  await admin.query(
    "UPDATE sessions SET reauthenticated_at=now() WHERE user_id=$1",
    [a.uid],
  );
  assert.equal(
    (
      await send(a.headers, {
        orderId: oid,
        confirmedNoExchangeActivity: false,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await send({ ...a.headers, "x-csrf-token": "wrong" })).statusCode,
    403,
  );
  await admin.query(
    "UPDATE sessions SET reauthenticated_at=now() WHERE user_id=$1",
    [b.uid],
  );
  assert.equal((await send(b.headers)).statusCode, 404);
  const accepted = await send(a.headers);
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().botStatus, "STOPPED");
  assert.equal((await call(a, "/start", "POST")).statusCode, 409);
  const monitor = (await call(a, "/monitor")).json();
  assert.equal(monitor.bot.status, "STOPPED");
  assert.ok(monitor.openOrders[0].recovery_requested_at);
  assert.equal(
    monitor.latestRecovery.action,
    "MISSING_ORDER_RECOVERY_REQUESTED",
  );
});

test("monitor reports scheduled backoff without claiming a fresh check or suppressing overdue warnings", async () => {
  const a = await actor(),
    now = Date.now();
  await recordObservation(a.tid, a.bid, {
    stage: "RISK_LOCKED",
    reasons: ["RECONCILIATION_REQUIRED"],
    retryAt: now + 60000,
  });
  await admin.query("UPDATE bot_monitoring SET checked_at=$1 WHERE bot_id=$2", [
    new Date(now - 240000),
    a.bid,
  ]);
  let monitor = (await call(a, "/monitor")).json();
  assert.equal(monitor.workerFresh, false);
  assert.equal(monitor.workerWaitingForRetry, true);
  assert.ok(!monitor.blockers.includes("WORKER_STATUS_STALE_OR_UNKNOWN"));
  await admin.query(
    "UPDATE bot_monitoring SET snapshot=jsonb_set(snapshot,'{retryAt}',to_jsonb($1::bigint)) WHERE bot_id=$2",
    [now - 60000, a.bid],
  );
  monitor = (await call(a, "/monitor")).json();
  assert.equal(monitor.workerWaitingForRetry, false);
  assert.ok(monitor.blockers.includes("WORKER_STATUS_STALE_OR_UNKNOWN"));
});
