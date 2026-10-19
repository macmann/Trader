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
        "executions",
        "orders",
        "signals",
        "ai_analyses",
        "positions",
        "bots",
        "exchange_connections",
        "audit_logs",
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
  const email = `test-${randomUUID()}@example.com`;
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
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
