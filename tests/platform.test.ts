import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import { app } from "../apps/api/src/server.ts";
import { pool, tenant } from "../apps/api/src/db.ts";
import { billingSignature } from "../apps/api/src/platform-routes.ts";
import { notificationCycle } from "../apps/worker/src/notifications.ts";
const admin = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
const origin = process.env.APP_ORIGIN!;
after(async () => {
  await app.close();
  await pool.end();
  await admin.end();
});
async function actor(plan = "PRO") {
  const id = randomUUID(),
    tid = randomUUID(),
    token = randomUUID(),
    csrf = randomUUID(),
    email = id + "@example.com";
  await admin.query(
    "INSERT INTO users(id,email,password_hash,verified) VALUES($1,$2,$3,true)",
    [id, email, "fixture"],
  );
  await admin.query("INSERT INTO workspaces(id,owner_id) VALUES($1,$2)", [
    tid,
    id,
  ]);
  await admin.query("UPDATE subscriptions SET plan=$1 WHERE tenant_id=$2", [
    plan,
    tid,
  ]);
  await admin.query(
    "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [createHash("sha256").update(token).digest("hex"), id, csrf],
  );
  return {
    id,
    tid,
    email,
    headers: { origin, cookie: "session=" + token, "x-csrf-token": csrf },
  };
}
async function call(
  a: Awaited<ReturnType<typeof actor>>,
  url: string,
  method: any = "GET",
  payload?: any,
) {
  return app.inject({ url: "/api" + url, method, headers: a.headers, payload });
}
function candles(n = 80, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    time: (offset + i) * 900000,
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100,
    volume: 100,
  }));
}
const configuration = {
  symbol: "BTCUSDT",
  strategyVersion: "dca-v1.0",
  config: { capital: 100, maxTrade: 20 },
  advancedConfig: {},
  settings: { feeBps: 10, slippageBps: 5 },
};
async function connection(a: Awaited<ReturnType<typeof actor>>) {
  const id = randomUUID();
  await admin.query(
    "INSERT INTO exchange_connections(id,tenant_id,name,environment,credentials,status,permissions) VALUES($1,$2,'Fixture','TESTNET','not-real','CONNECTED','{}')",
    [id, a.tid],
  );
  return id;
}
test("organization switching enforces current roles, protects owner and revokes removed members immediately", async () => {
  const owner = await actor(),
    viewer = await actor(),
    other = await actor();
  const created = await call(owner, "/workspaces", "POST", {
    name: "Research team",
  });
  assert.equal(created.statusCode, 201, created.body);
  const org = created.json().id;
  assert.equal(
    (await call(owner, "/auth/workspace", "POST", { tenantId: org }))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await call(owner, "/workspace/members", "PUT", {
        email: viewer.email,
        role: "VIEWER",
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await call(viewer, "/auth/workspace", "POST", { tenantId: org }))
      .statusCode,
    200,
  );
  assert.equal((await call(viewer, "/auth/me")).json().role, "VIEWER");
  assert.equal(
    (await call(viewer, "/paper", "POST", { name: "blocked", configuration }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await call(viewer, "/workspace/members", "PUT", {
        email: viewer.email,
        role: "ADMIN",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await call(other, "/auth/workspace", "POST", { tenantId: org }))
      .statusCode,
    403,
  );
  assert.equal(
    (await call(owner, "/workspace/members/" + owner.id, "DELETE")).statusCode,
    403,
  );
  assert.equal(
    (
      await call(owner, "/workspace/members", "PUT", {
        email: viewer.email,
        role: "TRADER",
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await call(viewer, "/paper", "POST", { name: "allowed", configuration }))
      .statusCode,
    201,
  );
  assert.equal(
    (
      await call(owner, "/workspace/members", "PUT", {
        email: viewer.email,
        role: "ADMIN",
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call(viewer, "/workspace/members", "PUT", {
        email: other.email,
        role: "ADMIN",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await call(owner, "/workspace/members/" + viewer.id, "DELETE")).statusCode,
    200,
  );
  assert.equal((await call(viewer, "/auth/me")).json().tenantId, viewer.tid);
  assert.deepEqual((await call(viewer, "/paper")).json(), []);
  const hidden = await tenant(other.tid, (db) =>
    db.query("SELECT * FROM workspace_members WHERE tenant_id=$1", [org]),
  );
  assert.equal(hidden.rowCount, 0);
});
test("signed billing events are replay-safe, ordered and never accepted from an unsigned browser request", async () => {
  const a = await actor("FREE");
  process.env.BILLING_WEBHOOK_SECRET = "isolated-test-gateway-secret";
  const body = {
      id: randomUUID(),
      tenantId: a.tid,
      plan: "PRO" as const,
      status: "ACTIVE" as const,
      periodEnd: new Date(Date.now() + 86400000).toISOString(),
      occurredAt: new Date().toISOString(),
    },
    ts = String(Math.floor(Date.now() / 1000));
  const post = (b: any, sig: string, timestamp = ts) =>
    app.inject({
      url: "/api/billing/gateway",
      method: "POST",
      headers: { "x-billing-timestamp": timestamp, "x-billing-signature": sig },
      payload: b,
    });
  assert.equal((await post(body, "0".repeat(64))).statusCode, 401);
  const signed = billingSignature(body, ts, process.env.BILLING_WEBHOOK_SECRET);
  assert.equal((await post(body, signed)).statusCode, 200);
  assert.equal((await post(body, signed)).json().duplicate, true);
  const old = {
    ...body,
    id: randomUUID(),
    plan: "FREE" as const,
    occurredAt: new Date(Date.now() - 60000).toISOString(),
  };
  assert.equal(
    (
      await post(
        old,
        billingSignature(old, ts, process.env.BILLING_WEBHOOK_SECRET),
      )
    ).statusCode,
    200,
  );
  assert.equal((await call(a, "/subscription")).json().plan, "PRO");
  assert.equal(
    (await post(body, signed, String(Number(ts) - 600))).statusCode,
    401,
  );
  await admin.query(
    "UPDATE subscriptions SET period_end=now()-interval '1 second' WHERE tenant_id=$1",
    [a.tid],
  );
  assert.equal((await call(a, "/subscription")).json().plan, "FREE");
  delete process.env.BILLING_WEBHOOK_SECRET;
});
test("plan limits serialize concurrent bot creation and monthly research consumption", async () => {
  const a = await actor("FREE"),
    cid = await connection(a);
  const created = await Promise.all(
    [1, 2].map((i) =>
      call(a, "/bots", "POST", {
        name: "Bot " + i,
        connectionId: cid,
        config: {},
      }),
    ),
  );
  assert.deepEqual(created.map((r) => r.statusCode).sort(), [201, 409]);
  const runs = await Promise.all(
    Array.from({ length: 12 }, () =>
      call(a, "/research", "POST", { configuration, candles: candles(3) }),
    ),
  );
  assert.equal(runs.filter((r) => r.statusCode === 201).length, 10);
  assert.equal(runs.filter((r) => r.statusCode === 429).length, 2);
  assert.equal(
    (await call(a, "/subscription"))
      .json()
      .usage.find((u: any) => u.metric === "backtests").units,
    10,
  );
});
test("paper sessions persist inventory, reject replay/out-of-order bars and isolate tenants without exchange calls", async () => {
  const a = await actor(),
    b = await actor();
  const created = await call(a, "/paper", "POST", {
    name: "Paper only",
    configuration,
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id;
  const first = await call(a, `/paper/${id}/advance`, "POST", {
    revision: 0,
    candles: candles(3),
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().result.fills.length, 1);
  assert.ok(first.json().result.position.quantity > 0);
  assert.equal(
    (
      await call(a, `/paper/${id}/advance`, "POST", {
        revision: 0,
        candles: candles(3),
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await call(a, `/paper/${id}/advance`, "POST", {
        revision: 1,
        candles: candles(2),
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call(b, `/paper/${id}/advance`, "POST", {
        revision: 1,
        candles: candles(2, 3),
      })
    ).statusCode,
    404,
  );
  const next = await call(a, `/paper/${id}/advance`, "POST", {
    revision: 1,
    candles: candles(2, 3),
  });
  assert.equal(next.statusCode, 200);
  assert.equal(next.json().result.fills.length, 1);
  assert.equal(
    (await call(a, `/paper/${id}/stop`, "POST", {})).statusCode,
    200,
  );
  assert.equal(
    (
      await call(a, `/paper/${id}/advance`, "POST", {
        revision: 2,
        candles: candles(1, 5),
      })
    ).statusCode,
    409,
  );
  assert.deepEqual((await call(b, "/paper")).json(), []);
  assert.equal(
    (
      await tenant(b.tid, (db) =>
        db.query("SELECT * FROM paper_sessions WHERE id=$1", [id]),
      )
    ).rowCount,
    0,
  );
});
test("marketplace versions use owned immutable research, pin subscriptions and copy only server-verified configuration", async () => {
  const creator = await actor(),
    follower = await actor();
  const run = await call(creator, "/research", "POST", {
    configuration,
    candles: candles(),
  });
  assert.equal(run.statusCode, 201, run.body);
  const payload = {
    name: "Transparent DCA",
    description: "Bounded experimental accumulation. No return guarantees.",
    researchRunId: run.json().id,
  };
  assert.equal(
    (await call(follower, "/marketplace/listings", "POST", payload)).statusCode,
    404,
  );
  assert.equal(
    (
      await call(creator, "/marketplace/listings", "POST", {
        ...payload,
        verifiedLiveResults: { returnPct: 999 },
      })
    ).statusCode,
    400,
  );
  const published = await call(
    creator,
    "/marketplace/listings",
    "POST",
    payload,
  );
  assert.equal(published.statusCode, 201, published.body);
  const version = published.json();
  const listing = (await call(follower, "/marketplace"))
    .json()
    .find((l: any) => l.version_id === version.versionId);
  assert.equal(listing.historical_results.simulationOnly, true);
  assert.equal(listing.verified_live_results, null);
  assert.equal(listing.risk_classification, "VERY_HIGH");
  await assert.rejects(
    tenant(creator.tid, (db) =>
      db.query("UPDATE marketplace_versions SET config='{}' WHERE id=$1", [
        version.versionId,
      ]),
    ),
    /permission denied/,
  );
  await assert.rejects(
    tenant(creator.tid, (db) =>
      db.query("UPDATE research_runs SET result='{}' WHERE id=$1", [
        run.json().id,
      ]),
    ),
    /permission denied/,
  );
  const cid = await connection(follower);
  assert.equal(
    (
      await call(follower, "/bots", "POST", {
        name: "No subscription",
        connectionId: cid,
        marketplaceVersionId: version.versionId,
        config: {},
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        follower,
        `/marketplace/versions/${version.versionId}/subscribe`,
        "POST",
        {},
      )
    ).statusCode,
    200,
  );
  const created = await call(follower, "/bots", "POST", {
    name: "Pinned bot",
    connectionId: cid,
    marketplaceVersionId: version.versionId,
    config: { capital: 999, maxTrade: 999 },
    strategyVersion: "trend-v1.0",
  });
  assert.equal(created.statusCode, 201, created.body);
  const bot = (await call(follower, "/bots")).json()[0];
  assert.equal(bot.config.capital, 100);
  assert.equal(bot.strategy_version, "dca-v1.0");
  assert.equal(bot.marketplace_version_id, version.versionId);
  assert.equal(bot.status, "STOPPED");
  const second = await call(creator, "/marketplace/listings", "POST", {
    ...payload,
    listingId: version.listingId,
  });
  assert.equal(second.statusCode, 201);
  assert.equal(second.json().version, 2);
  const old = (await call(follower, "/marketplace"))
    .json()
    .find((l: any) => l.version_id === version.versionId);
  assert.equal(old.subscribed, true);
  assert.equal(
    (
      await call(
        follower,
        `/marketplace/listings/${version.listingId}/retire`,
        "POST",
        {},
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        creator,
        `/marketplace/listings/${version.listingId}/retire`,
        "POST",
        {},
      )
    ).statusCode,
    200,
  );
  assert.ok(
    !(await call(follower, "/marketplace"))
      .json()
      .some((l: any) => l.id === version.listingId),
  );
  assert.equal(
    (await call(follower, "/bots")).json()[0].marketplace_version_id,
    version.versionId,
  );
});
test("notification delivery is tenant scoped, redacted and not retried after an uncertain send", async () => {
  const a = await actor();
  assert.equal(
    (
      await call(a, "/notifications/settings", "PUT", {
        enabled: true,
        chatId: "12345",
      })
    ).statusCode,
    200,
  );
  const seen: any[] = [];
  const transport = (async (_url: any, init: any) => {
    seen.push(JSON.parse(init.body));
    throw Error("SIMULATED_TIMEOUT");
  }) as typeof fetch;
  await notificationCycle(transport, "fake-transport-test-token");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].chat_id, "12345");
  assert.ok(!JSON.stringify(seen).includes("apiSecret"));
  await notificationCycle(transport, "fake-transport-test-token");
  assert.equal(seen.length, 1);
  const notifications = (await call(a, "/notifications")).json();
  assert.equal(notifications[0].telegram_state, "FAILED");
});
test("automatic paper feed warms up before creation, advances without credentials and stops on missing history", async () => {
  const { paperCycle } = await import("../apps/worker/src/paper.ts");
  const a = await actor();
  const create = await call(a, "/paper", "POST", {
    name: "Automatic paper",
    configuration,
    feedMode: "MARKET",
  });
  assert.equal(create.statusCode, 201, create.body);
  const id = create.json().id;
  const now = Math.floor(Date.now() / 900000) * 900000;
  await admin.query("UPDATE paper_sessions SET created_at=$1 WHERE id=$2", [
    new Date(now),
    id,
  ]);
  const initial = candles(60).map((c, i) => ({
    ...c,
    time: now - (60 - i) * 900000,
  }));
  let calls = 0;
  const load = async () => {
    calls++;
    return initial;
  };
  await paperCycle(load, now + 1000);
  let p = (await call(a, "/paper")).json()[0];
  assert.equal(p.result.fills.length, 0);
  assert.equal(p.revision, 1);
  initial.push({ ...initial.at(-1)!, time: now });
  await paperCycle(load, now + 900000 + 1000);
  initial.push({ ...initial.at(-1)!, time: now + 900000 });
  await paperCycle(load, now + 1800000 + 1000);
  p = (await call(a, "/paper")).json()[0];
  assert.equal(p.result.fills.length, 1);
  assert.equal(p.result.simulationOnly, true);
  assert.equal(calls, 3);
  assert.equal(
    (
      await call(a, `/paper/${id}/advance`, "POST", {
        revision: p.revision,
        candles: candles(1),
      })
    ).statusCode,
    409,
  );
  const gap = [{ ...initial.at(-1)!, time: now + 3600000 }];
  await paperCycle(async () => gap, now + 4500000 + 1000);
  assert.equal((await call(a, "/paper")).json()[0].status, "STOPPED");
});
test("marketplace evidence accepts only owned matching reconciled closed trades and keeps Testnet separate from Live", async () => {
  const a = await actor(),
    b = await actor(),
    cid = await connection(a);
  const run = await call(a, "/research", "POST", {
    configuration,
    candles: candles(),
  });
  const pub = await call(a, "/marketplace/listings", "POST", {
    name: "Evidence fixture",
    description: "Simulated integration fixture",
    researchRunId: run.json().id,
  });
  const v = pub.json();
  await call(a, `/marketplace/versions/${v.versionId}/subscribe`, "POST", {});
  const created = await call(a, "/bots", "POST", {
    name: "Proof fixture",
    connectionId: cid,
    marketplaceVersionId: v.versionId,
    config: {},
  });
  const botId = created.json().id;
  assert.equal(
    (
      await call(a, `/marketplace/listings/${v.listingId}/evidence`, "POST", {
        botId,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await call(a, `/marketplace/listings/${v.listingId}/evidence`, "POST", {
        botId,
        result: { netReturnPct: 999 },
      })
    ).statusCode,
    400,
  );
  // Only the test's administrator seeds this simulated ledger; the application exposes no fill/performance-write endpoint.
  const orderId = randomUUID(),
    executionId = "evidence-" + randomUUID();
  await admin.query(
    "INSERT INTO orders(id,tenant_id,bot_id,client_id,side,quantity,state,strategy_version) VALUES($1,$2,$3,$4,'Sell',1,'Filled','dca-v1.0')",
    [orderId, a.tid, botId, randomUUID()],
  );
  await admin.query(
    "INSERT INTO executions(id,tenant_id,order_id,quantity,price,fee,executed_at) VALUES($1,$2,$3,1,100,0,now())",
    [executionId, a.tid, orderId],
  );
  await admin.query(
    "INSERT INTO trade_cycles(id,tenant_id,bot_id,strategy_version,net_pnl,closing_execution_id,closed_at) VALUES($1,$2,$3,'dca-v1.0',-2,$4,now())",
    [randomUUID(), a.tid, botId, executionId],
  );
  const proof = await call(
    a,
    `/marketplace/listings/${v.listingId}/evidence`,
    "POST",
    { botId },
  );
  assert.equal(proof.statusCode, 200, proof.body);
  assert.ok(Math.abs(proof.json().result.netReturnPct + 2) < 1e-8);
  const visible = (await call(b, "/marketplace"))
    .json()
    .find((l: any) => l.version_id === v.versionId);
  assert.equal(visible.verified_live_results, null);
  assert.equal(visible.verified_testnet_results.environment, "TESTNET");
  assert.equal(visible.verified_testnet_results.closedTradeDrawdownPct, 2);
  await assert.rejects(
    tenant(a.tid, (db) =>
      db.query(
        "UPDATE marketplace_evidence SET result='{}' WHERE version_id=$1",
        [v.versionId],
      ),
    ),
    /permission denied/,
  );
});
