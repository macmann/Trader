import { jsonRequestOptions } from "../apps/web/src/http.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
process.env.NODE_ENV = "test";
const { app } = await import("../apps/api/src/server.ts");
const { pool, tenant } = await import("../apps/api/src/db.ts");
const admin = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
const origin = process.env.APP_ORIGIN!;
const password = "a-strong-test-password-2026";
const users: string[] = [];
after(async () => {
  for (const id of users) {
    await admin.query("DELETE FROM auth_tokens WHERE user_id=$1", [id]);
    await admin.query("DELETE FROM sessions WHERE user_id=$1", [id]);
    await admin.query("DELETE FROM login_history WHERE user_id=$1", [id]);
    const tid = (
      await admin.query("SELECT id FROM workspaces WHERE owner_id=$1", [id])
    ).rows[0]?.id;
    if (tid) {
      for (const table of [
        "ai_strategy_decisions",
        "trade_cycles",
        "order_events",
        "executions",
        "orders",
        "signals",
        "ai_analyses",
        "positions",
        "bots",
        "custom_strategies",
        "exchange_connections",
        "audit_logs",
        "portfolio_limits",
      ])
        await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tid]);
      await admin.query("DELETE FROM workspaces WHERE id=$1", [tid]);
    }
    await admin.query("DELETE FROM users WHERE id=$1", [id]);
  }
  await app.close();
  await pool.end();
  await admin.end();
});
async function account() {
  const remoteAddress = `10.99.0.${users.length + 1}`;
  const email = `test-${randomUUID()}@example.com`;
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress,
    headers: { origin },
    payload: { email, password },
  });
  assert.equal(reg.statusCode, 201, reg.body);
  const u = (
    await admin.query(
      "SELECT u.id,w.id AS tid FROM users u JOIN workspaces w ON w.owner_id=u.id WHERE email=$1",
      [email],
    )
  ).rows[0];
  users.push(u.id);
  await admin.query("UPDATE subscriptions SET plan='PRO' WHERE tenant_id=$1", [
    u.tid,
  ]);
  const mail = (
    await readFile(
      process.env.TEST_MAIL_OUTBOX_PATH ?? ".local/mail.jsonl",
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((v) => JSON.parse(v))
    .find((v) => v.to === email && v.kind === "verify");
  const token = new URL(mail.url).searchParams.get("verify");
  const verified = await app.inject({
    method: "POST",
    url: "/api/auth/verify",
    headers: { origin },
    payload: { token },
  });
  assert.equal(verified.statusCode, 200);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress,
    headers: { origin },
    payload: { email, password },
  });
  assert.equal(login.statusCode, 200, login.body);
  const setCookie = String(login.headers["set-cookie"]);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/i);
  return {
    email,
    userId: u.id,
    tid: u.tid,
    headers: {
      origin,
      cookie: setCookie.split(";")[0],
      "x-csrf-token": login.json().csrf,
    },
  };
}
test("real database auth, session protection, CSRF, tenant RLS and bot ownership", async () => {
  const a = await account(),
    b = await account();
  assert.equal((await app.inject({ url: "/api/bots" })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/stop-all",
        headers: { cookie: a.headers.cookie, origin },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/stop-all",
        headers: { ...a.headers, origin: "https://evil.example" },
        payload: {},
      })
    ).statusCode,
    403,
  );
  const ca = randomUUID(),
    cb = randomUUID();
  for (const [u, c] of [
    [a, ca],
    [b, cb],
  ] as const)
    await tenant(u.tid, async (db) => {
      await db.query(
        "INSERT INTO exchange_connections(id,tenant_id,name,environment,credentials,status,permissions) VALUES($1,$2,'Test fixture','TESTNET','not-a-real-key','CONNECTED','{}')",
        [c, u.tid],
      );
    });
  const create = await app.inject({
    method: "POST",
    url: "/api/bots",
    headers: a.headers,
    payload: { name: "Tenant A bot", connectionId: ca, config: {} },
  });
  assert.equal(create.statusCode, 201, create.body);
  const botId = create.json().id;
  // Reproduce the browser's original empty-JSON request before exercising the shared fix.
  const emptyJson = await app.inject({
    method: "POST",
    url: `/api/bots/${botId}/start`,
    headers: { ...a.headers, "Content-Type": "application/json" },
  });
  assert.equal(emptyJson.statusCode, 400);
  assert.equal(emptyJson.json().error, "REQUEST_REJECTED");
  const actionOptions = jsonRequestOptions("POST", a.headers["x-csrf-token"]);
  for (const [action, status] of [
    ["start", "STARTING"],
    ["pause", "PAUSED"],
    ["stop", "STOPPED"],
  ]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/${action}`,
      headers: { ...a.headers, ...actionOptions.headers },
      payload: actionOptions.body,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, status);
    assert.equal(
      (await app.inject({ url: "/api/bots", headers: a.headers })).json()[0]
        .status,
      status,
    );
  }
  const crossCreate = await app.inject({
    method: "POST",
    url: "/api/bots",
    headers: b.headers,
    payload: { name: "Must fail", connectionId: ca, config: {} },
  });
  assert.equal(crossCreate.statusCode, 400);
  const listA = await app.inject({ url: "/api/bots", headers: a.headers }),
    listB = await app.inject({ url: "/api/bots", headers: b.headers });
  assert.equal(listA.json().length, 1);
  assert.equal(listB.json().length, 0);
  const crossStart = await app.inject({
    method: "POST",
    url: `/api/bots/${botId}/start`,
    headers: b.headers,
    payload: {},
  });
  assert.equal(crossStart.statusCode, 404);
  const direct = await tenant(
    b.tid,
    async (db) =>
      (await db.query("SELECT * FROM bots WHERE id=$1", [botId])).rows,
  );
  assert.equal(
    direct.length,
    0,
    "RLS must hide records even without explicit tenant predicate",
  );
  await assert.rejects(
    tenant(b.tid, async (db) => {
      await db.query(
        "INSERT INTO bots(id,tenant_id,connection_id,name,config) VALUES($1,$2,$3,'cross tenant','{}')",
        [randomUUID(), a.tid, ca],
      );
    }),
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/bots/${botId}/start`,
        headers: a.headers,
        payload: {},
      })
    ).json().status,
    "STARTING",
  );
  await app.inject({
    method: "POST",
    url: "/api/stop-all",
    headers: b.headers,
    payload: {},
  });
  assert.equal(
    (await app.inject({ url: "/api/bots", headers: a.headers })).json()[0]
      .status,
    "STARTING",
  );
  await app.inject({
    method: "POST",
    url: "/api/stop-all",
    headers: a.headers,
    payload: {},
  });
  assert.equal(
    (await app.inject({ url: "/api/bots", headers: a.headers })).json()[0]
      .status,
    "STOPPED",
  );

  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/bots/${botId}/ai`,
        headers: b.headers,
        payload: { mode: "FILTER" },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/bots/${botId}/ai`,
        headers: a.headers,
        payload: { mode: "WEIGHTED" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/bots/${botId}/ai`,
        headers: a.headers,
        payload: { mode: "FILTER" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ url: "/api/bots", headers: a.headers })).json()[0]
      .ai_mode,
    "FILTER",
  );
  await app.inject({
    method: "POST",
    url: `/api/bots/${botId}/start`,
    headers: a.headers,
    payload: {},
  });
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/bots/${botId}/ai`,
        headers: a.headers,
        payload: { mode: "ADVISORY" },
      })
    ).statusCode,
    409,
  );
  await app.inject({
    method: "POST",
    url: "/api/stop-all",
    headers: a.headers,
    payload: {},
  });
  const { analyzeBot } = await import("../apps/worker/src/intelligence.ts");
  const snapshot = {
    symbol: "BTCUSDT" as const,
    interval: "15m" as const,
    candleTime: Math.floor(Date.now() / 900000) * 900000 - 900000,
    price: 100,
    indicators: {
      ema9: 101,
      ema21: 99,
      rsi14: 57,
      atr14: 3,
      relativeVolume: 1.2,
    },
    news: [],
  };
  const analysis = await tenant(a.tid, (db) =>
    analyzeBot(db, a.tid, botId, "FILTER", snapshot, "LONG", true, null),
  );
  assert.equal(analysis.gate.allowed, false);
  assert.equal(
    (await app.inject({ url: "/api/ai/analyses", headers: a.headers })).json()
      .length,
    1,
  );
  assert.equal(
    (await app.inject({ url: "/api/ai/analyses", headers: b.headers })).json()
      .length,
    0,
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/ai/analyses?botId=${botId}`,
        headers: b.headers,
      })
    ).json().length,
    0,
  );
  const comparison = (
    await app.inject({ url: "/api/ai/comparison", headers: a.headers })
  ).json();
  assert.equal(comparison.strategy_approved, 1);
  assert.equal(comparison.filter_approved, 0);
  assert.equal(
    (await app.inject({ url: "/api/ai/comparison", headers: b.headers })).json()
      .candidate_signals,
    0,
  );
  assert.ok(
    !(
      await app.inject({ url: "/api/ai/status", headers: a.headers })
    ).body.includes("AI_API_KEY"),
  );
  assert.equal(
    (await app.inject({ url: "/api/news", headers: a.headers })).statusCode,
    200,
  );

  const options = (
    await app.inject({ url: "/api/trading/options", headers: a.headers })
  ).json();
  assert.deepEqual(options.symbols, ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  assert.equal(options.derivativesSupported, true);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/bots",
        headers: a.headers,
        payload: {
          name: "No derivatives",
          connectionId: ca,
          config: {},
          symbol: "BTCUSD-PERP",
        },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/bots",
        headers: a.headers,
        payload: {
          name: "No derivative mode",
          connectionId: ca,
          config: {},
          marketType: "LINEAR",
        },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: "/api/portfolio/limits",
        headers: a.headers,
        payload: {
          maxTotalAllocation: 250,
          maxConnectionAllocation: 250,
          maxSymbolAllocation: 150,
          maxOpenPositions: 2,
        },
      })
    ).statusCode,
    200,
  );
  const creates = await Promise.all(
    ["ETHUSDT", "SOLUSDT"].map((symbol) =>
      app.inject({
        method: "POST",
        url: "/api/bots",
        headers: a.headers,
        payload: {
          name: symbol + " bot",
          connectionId: ca,
          symbol,
          strategyVersion: "breakout-v1.0",
          config: {},
        },
      }),
    ),
  );
  assert.deepEqual(
    creates.map((r) => r.statusCode).sort(),
    [201, 409],
    "Workspace lock prevents concurrent allocation oversubscription",
  );
  const secondId = creates.find((r) => r.statusCode === 201)!.json().id;
  const portfolio = (
    await app.inject({ url: "/api/portfolio", headers: a.headers })
  ).json();
  assert.equal(portfolio.allocated, 200);
  assert.equal(
    (await app.inject({ url: "/api/portfolio", headers: b.headers })).json()
      .allocated,
    0,
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: "/api/portfolio/limits",
        headers: a.headers,
        payload: {
          maxTotalAllocation: 100,
          maxConnectionAllocation: 250,
          maxSymbolAllocation: 150,
          maxOpenPositions: 2,
        },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/bots/${secondId}/config`,
        headers: b.headers,
        payload: { symbol: "BTCUSDT" },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/bots/${secondId}/config`,
        headers: a.headers,
        payload: {
          strategyVersion: "dca-v1.0",
          advancedConfig: { sizing: "RISK_PERCENT" },
        },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/bots/${secondId}/start`,
        headers: a.headers,
        payload: {},
      })
    ).statusCode,
    200,
  );
  await app.inject({
    method: "POST",
    url: `/api/bots/${secondId}/stop`,
    headers: a.headers,
    payload: {},
  });
  await app.inject({
    method: "POST",
    url: `/api/bots/${secondId}/stop`,
    headers: a.headers,
    payload: {},
  });
  const hypothetical = await app.inject({
    method: "POST",
    url: `/api/bots/${secondId}/preview`,
    headers: a.headers,
    payload: { price: 100, availableBalance: 5000 },
  });
  assert.equal(hypothetical.statusCode, 200, hypothetical.body);
  assert.equal(hypothetical.json().simulationOnly, true);
  assert.equal(hypothetical.json().orderSubmissionEnabled, false);
  assert.equal(hypothetical.json().proposal.side, "BUY");
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/bots/${secondId}/preview`,
        headers: b.headers,
        payload: { price: 100, availableBalance: 100 },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ url: "/api/orders", headers: a.headers })).json()
      .length,
    0,
    "Preview never creates order records",
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/bots/${secondId}/config`,
        headers: a.headers,
        payload: {
          strategyVersion: "trend-v1.0",
          advancedConfig: { entryType: "LIMIT" },
        },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/bots/${secondId}/start`,
        headers: a.headers,
        payload: {},
      })
    ).statusCode,
    200,
  );
  await app.inject({
    method: "POST",
    url: `/api/bots/${secondId}/stop`,
    headers: a.headers,
    payload: {},
  });
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/bots/${secondId}/config`,
        headers: a.headers,
        payload: {
          strategyVersion: "grid-accumulation-v1.0",
          advancedConfig: {},
        },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/bots/${secondId}/config`,
        headers: a.headers,
        payload: {
          strategyVersion: "grid-accumulation-v1.0",
          advancedConfig: { gridLower: 80, gridUpper: 120, gridLevels: 5 },
        },
      })
    ).statusCode,
    200,
  );
  const pendingId = randomUUID();
  await tenant(a.tid, async (db) => {
    const symbol = (
      await db.query("SELECT symbol FROM bots WHERE id=$1", [secondId])
    ).rows[0].symbol;
    await db.query("UPDATE positions SET quantity=1,cost=10 WHERE bot_id=$1", [
      secondId,
    ]);
    await db.query(
      "INSERT INTO orders(id,tenant_id,bot_id,client_id,side,quantity,state,symbol,requested_notional) VALUES($1,$2,$3,$4,'Buy',1,'SUBMITTED',$5,20)",
      [pendingId, a.tid, secondId, randomUUID(), symbol],
    );
  });
  const reserved = (
    await app.inject({ url: "/api/portfolio", headers: a.headers })
  ).json();
  assert.equal(reserved.exposure, 10);
  assert.equal(reserved.reserved, 20);
  assert.equal(reserved.openPositions, 1);
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/bots/${secondId}/config`,
        headers: a.headers,
        payload: { symbol: "BTCUSDT" },
      })
    ).statusCode,
    409,
  );
  await tenant(a.tid, async (db) => {
    await db.query("UPDATE orders SET requested_notional=NULL WHERE id=$1", [
      pendingId,
    ]);
  });
  assert.equal(
    (await app.inject({ url: "/api/portfolio", headers: a.headers })).json()
      .unknownPending,
    true,
  );
  await tenant(a.tid, async (db) => {
    await db.query("UPDATE orders SET state='Cancelled' WHERE id=$1", [
      pendingId,
    ]);
  });
  const released = (
    await app.inject({ url: "/api/portfolio", headers: a.headers })
  ).json();
  assert.equal(released.reserved, 0);
  assert.equal(released.unknownPending, false);
  assert.equal(
    (
      await tenant(
        b.tid,
        async (db) =>
          (
            await db.query(
              "SELECT * FROM portfolio_limits WHERE tenant_id=$1",
              [a.tid],
            )
          ).rows,
      )
    ).length,
    0,
  );
  await tenant(a.tid, async (db) => {
    await db.query("DELETE FROM orders WHERE id=$1", [pendingId]);
    await db.query("UPDATE positions SET quantity=0,cost=0 WHERE bot_id=$1", [
      secondId,
    ]);
  });
  const connectionJson = (
    await app.inject({ url: "/api/connections", headers: a.headers })
  ).body;
  assert.ok(!connectionJson.includes("credentials"));
  assert.ok(!connectionJson.includes("not-a-real-key"));
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/connections",
        headers: a.headers,
        payload: {
          name: "Live",
          environment: "LIVE",
          apiKey: "12345678",
          apiSecret: "12345678",
        },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/connections/${ca}`,
        headers: a.headers,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/bots/${botId}/start`,
        headers: a.headers,
        payload: {},
      })
    ).statusCode,
    409,
  );
  const role = (
    await pool.query(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  assert.equal(role.rolsuper, false);
  assert.equal(role.rolbypassrls, false);
  await assert.rejects(
    tenant(a.tid, async (db) => {
      await db.query("DELETE FROM audit_logs");
    }),
    "Application role cannot mutate audit history",
  );
  const oldHash = (
    await admin.query("SELECT password_hash FROM users WHERE id=$1", [a.userId])
  ).rows[0].password_hash;
  assert.match(oldHash, /^\$argon2id\$/);
  await app.inject({
    method: "POST",
    url: "/api/auth/reset-request",
    headers: { origin },
    payload: { email: a.email },
  });
  const mail = (
      await readFile(
        process.env.TEST_MAIL_OUTBOX_PATH ?? ".local/mail.jsonl",
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((v) => JSON.parse(v))
      .find((v) => v.to === a.email && v.kind === "reset"),
    token = new URL(mail.url).searchParams.get("reset");
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/reset",
        headers: { origin },
        payload: { token, password: "new-strong-password-2026" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ url: "/api/auth/me", headers: a.headers })).statusCode,
    401,
    "Reset revokes all sessions",
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/reset",
        headers: { origin },
        payload: { token, password: "another-strong-password" },
      })
    ).statusCode,
    400,
    "Reset token is single-use",
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*) AS n FROM auth_tokens WHERE token_hash=$1",
        [createHash("sha256").update(token!).digest("hex")],
      )
    ).rows[0].n,
    "0",
  );
});
test("failed transactional mail revokes links and password reset does not reveal registered emails", async () => {
  const a = await account(),
    savedFetch = globalThis.fetch;
  const saved = {
    MAIL_MODE: process.env.MAIL_MODE,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    MAIL_FROM: process.env.MAIL_FROM,
  };
  process.env.MAIL_MODE = "resend";
  process.env.RESEND_API_KEY = "fixture-key-only";
  process.env.MAIL_FROM = "accounts@example.com";
  globalThis.fetch = (async () =>
    new Response("private-provider-error", { status: 503 })) as typeof fetch;
  try {
    const resend = await app.inject({
      url: "/api/auth/resend-verification",
      method: "POST",
      headers: a.headers,
      payload: {},
    });
    assert.equal(resend.statusCode, 503);
    const registered = await app.inject({
        url: "/api/auth/reset-request",
        method: "POST",
        headers: { origin },
        payload: { email: a.email },
      }),
      unknown = await app.inject({
        url: "/api/auth/reset-request",
        method: "POST",
        headers: { origin },
        payload: { email: "absent-" + randomUUID() + "@example.com" },
      });
    assert.equal(registered.statusCode, 200, registered.body);
    assert.equal(unknown.statusCode, 200, unknown.body);
    assert.deepEqual(registered.json(), unknown.json());
    assert.equal(
      Number(
        (
          await admin.query(
            "SELECT count(*) AS n FROM auth_tokens WHERE user_id=$1",
            [a.userId],
          )
        ).rows[0].n,
      ),
      0,
    );
    assert.ok(!resend.body.includes("private-provider-error"));
  } finally {
    globalThis.fetch = savedFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("EU connections require explicit live read-only acknowledgement and cannot create bots", async () => {
  const a = await account();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://api.bybit.eu");
    assert.equal(init.method, "GET");
    assert.equal(init.headers["X-BAPI-API-KEY"], "eu-fixture-key");
    calls++;
    return new Response(
      JSON.stringify({
        retCode: 0,
        result:
          url.pathname === "/v5/user/query-api"
            ? { readOnly: 1, permissions: {} }
            : { list: [] },
      }),
    );
  }) as typeof fetch;
  const payload = {
    provider: "BYBIT_EU",
    environment: "LIVE",
    name: "EU read-only fixture",
    apiKey: "  eu-fixture-key  ",
    apiSecret: "  eu-fixture-secret  ",
  };
  try {
    const blocked = await app.inject({
      method: "POST",
      url: "/api/connections",
      headers: a.headers,
      payload,
    });
    assert.equal(blocked.statusCode, 400);
    assert.equal(calls, 0);
    const connection = await app.inject({
      method: "POST",
      url: "/api/connections",
      headers: a.headers,
      payload: { ...payload, readOnlyAcknowledged: true },
    });
    assert.equal(connection.statusCode, 201, connection.body);
    assert.equal(connection.json().permissions.trading, false);
    const stored = (
      await admin.query(
        "SELECT environment,provider,credentials FROM exchange_connections WHERE id=$1",
        [connection.json().id],
      )
    ).rows[0];
    assert.equal(stored.environment, "LIVE");
    assert.equal(stored.provider, "BYBIT_EU");
    assert.ok(!stored.credentials.includes("eu-fixture-secret"));
    const bot = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers: a.headers,
      payload: {
        name: "Blocked live bot",
        connectionId: connection.json().id,
        config: {
          capital: 100,
          maxTrade: 20,
          stopLossPct: 2,
          takeProfitPct: 4,
          dailyLossLimit: 5,
        },
      },
    });
    assert.equal(bot.statusCode, 400, bot.body);
    assert.equal(bot.json().error, "CONNECTED_TESTNET_EXCHANGE_REQUIRED");
    assert.equal(
      (
        await admin.query("SELECT * FROM bots WHERE connection_id=$1", [
          connection.json().id,
        ])
      ).rowCount,
      0,
    );
    globalThis.fetch = (async (input: any) => {
      const url = new URL(input);
      assert.equal(url.origin, "https://api-testnet.bybit.eu");
      return new Response(
        JSON.stringify({
          retCode: 0,
          result:
            url.pathname === "/v5/user/query-api"
              ? { readOnly: 0, permissions: { Spot: ["SpotTrade"] } }
              : { list: [] },
        }),
      );
    }) as typeof fetch;
    const euTestnet = await app.inject({
      method: "POST",
      url: "/api/connections",
      headers: a.headers,
      payload: {
        ...payload,
        provider: "BYBIT_EU_TESTNET",
        environment: "TESTNET",
      },
    });
    assert.equal(euTestnet.statusCode, 201, euTestnet.body);
    const testBot = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers: a.headers,
      payload: {
        name: "EU Testnet bot",
        connectionId: euTestnet.json().id,
        config: {},
      },
    });
    assert.equal(testBot.statusCode, 201, testBot.body);
  } finally {
    globalThis.fetch = original;
  }
});

test("strategy creator versions are immutable, tenant scoped and configurable only with no exposure", async () => {
  const a = await account(),
    b = await account(),
    cid = randomUUID();
  const rules = {
    entry: [
      {
        left: { indicator: "EMA", period: 9 },
        operator: "GT",
        right: { indicator: "MA", period: 21 },
      },
    ],
    exit: [
      { left: { indicator: "RSI", period: 14 }, operator: "LT", right: 40 },
    ],
  };
  const first = await app.inject({
    method: "POST",
    url: "/api/strategies",
    headers: a.headers,
    payload: { name: "My trend", rules },
  });
  assert.equal(first.statusCode, 201, first.body);
  const id = first.json().id;
  const second = await app.inject({
    method: "POST",
    url: "/api/strategies",
    headers: a.headers,
    payload: { name: "My revised trend", previousVersionId: id, rules },
  });
  assert.equal(second.statusCode, 201, second.body);
  assert.equal(second.json().version, 2);
  const list = await app.inject({ url: "/api/strategies", headers: a.headers });
  assert.equal(list.json().length, 2);
  assert.equal(
    (await app.inject({ url: "/api/strategies", headers: b.headers })).json()
      .length,
    0,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/strategies",
        headers: b.headers,
        payload: { name: "Other", previousVersionId: id, rules },
      })
    ).statusCode,
    404,
  );
  await assert.rejects(
    tenant(a.tid, (db) =>
      db.query("UPDATE custom_strategies SET name='changed' WHERE id=$1", [id]),
    ),
    /permission denied/,
  );
  await tenant(a.tid, (db) =>
    db.query(
      "INSERT INTO exchange_connections(id,tenant_id,name,environment,credentials,status,permissions) VALUES($1,$2,'Fixture','TESTNET','none','CONNECTED','{}')",
      [cid, a.tid],
    ),
  );
  const create = await app.inject({
    method: "POST",
    url: "/api/bots",
    headers: a.headers,
    payload: {
      name: "Custom 30m",
      connectionId: cid,
      strategyVersion: "custom-v1.0",
      customStrategyId: id,
      timeframe: "30",
      config: {},
    },
  });
  assert.equal(create.statusCode, 201, create.body);
  const botId = create.json().id;
  const change = await app.inject({
    method: "PATCH",
    url: `/api/bots/${botId}/config`,
    headers: a.headers,
    payload: { timeframe: "60", customStrategyId: second.json().id },
  });
  assert.equal(change.statusCode, 200, change.body);
  const monitor = await app.inject({
    url: `/api/bots/${botId}/monitor`,
    headers: a.headers,
  });
  assert.equal(monitor.json().bot.timeframe, "60");
  assert.equal(monitor.json().bot.custom_strategy_id, second.json().id);
  const invalid = await app.inject({
    method: "POST",
    url: "/api/bots",
    headers: b.headers,
    payload: {
      name: "Wrong tenant",
      connectionId: cid,
      strategyVersion: "custom-v1.0",
      customStrategyId: id,
      timeframe: "15",
      config: {},
    },
  });
  assert.equal(invalid.statusCode, 400, invalid.body);
  const badInterval = await app.inject({
    method: "PATCH",
    url: `/api/bots/${botId}/config`,
    headers: a.headers,
    payload: { timeframe: "2" },
  });
  assert.equal(badInterval.statusCode, 400);
  const models = await app.inject({
    url: "/api/strategies/models",
    headers: a.headers,
  });
  assert.equal(models.statusCode, 200);
  assert.equal("AI_API_KEY" in models.json(), false);
  await tenant(a.tid, (db) =>
    db.query("UPDATE positions SET quantity=0.1 WHERE bot_id=$1", [botId]),
  );
  const exposed = await app.inject({
    method: "PATCH",
    url: `/api/bots/${botId}/config`,
    headers: a.headers,
    payload: { timeframe: "15" },
  });
  assert.equal(exposed.statusCode, 409);
  await tenant(a.tid, async (db) => {
    await db.query(
      "INSERT INTO signals(id,tenant_id,bot_id,candle_time,strategy_version,data,decision) SELECT gen_random_uuid(),$1,$2,n,'custom-v1.0',$3::jsonb,$4::jsonb FROM generate_series(1,501) n",
      [
        a.tid,
        botId,
        JSON.stringify({
          direction: "NONE",
          reasons: ["ENTRY_RULE_1_WAIT"],
          apiSecret: "do-not-export-fixture",
          diagnostics: { RSI14: 40 },
        }),
        JSON.stringify({ approved: false, outcome: "NO_ENTRY_SIGNAL" }),
      ],
    );
  });
  const exported = await app.inject({
    url: `/api/bots/${botId}/diagnostics?hours=24`,
    headers: a.headers,
  });
  assert.equal(exported.statusCode, 200, exported.body);
  const report = exported.json();
  assert.equal(report.history.signals.total, 501);
  assert.equal(report.history.signals.included, 500);
  assert.equal(report.history.signals.truncated, true);
  assert.equal(report.summary.counts.fills, 0);
  assert.equal(report.bot.custom_strategy_id, second.json().id);
  assert.ok(
    report.summary.findings.some((v: string) =>
      v.includes("no entry or exit signal"),
    ),
  );
  assert.equal(exported.body.includes("do-not-export-fixture"), false);
  assert.equal("credentials" in report.bot, false);
  assert.equal(
    (
      await app.inject({
        url: `/api/bots/${botId}/diagnostics`,
        headers: b.headers,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ url: `/api/bots/${botId}/diagnostics` })).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/bots/${botId}/diagnostics?hours=999`,
        headers: a.headers,
      })
    ).statusCode,
    400,
  );
});
