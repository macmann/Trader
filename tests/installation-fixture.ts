import assert from "node:assert/strict";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { app } from "../apps/api/src/server.ts";
import { pool, tenant } from "../apps/api/src/db.ts";
import {
  entitlements,
  consume,
  userContext,
} from "../apps/api/src/platform.ts";
import {
  runtimeConfiguration,
  sealSettings,
  savedSettings,
  runtimeProvider,
  testnetExecutionEnabled,
} from "../apps/api/src/installation.ts";
import {
  deliverAccountLink,
  validateMailConfiguration,
} from "../apps/api/src/mail.ts";
import { closeIntelligence } from "../apps/worker/src/intelligence.ts";
const admin = new pg.Client({
  connectionString: process.env.DATABASE_ADMIN_URL,
});
await admin.connect();
const token = randomBytes(32).toString("hex"),
  password = "installation-password-fixture-2026",
  origin = process.env.APP_ORIGIN!;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
try {
  validateMailConfiguration({ NODE_ENV: "production", MAIL_MODE: "disabled" });
  assert.equal((await app.inject({ url: "/api/health" })).statusCode, 200);
  const migration = (
    await admin.query(
      "SELECT name,checksum FROM schema_migrations ORDER BY name DESC LIMIT 1",
    )
  ).rows[0];
  await admin.query(
    "UPDATE schema_migrations SET checksum='incomplete' WHERE name=$1",
    [migration.name],
  );
  assert.equal((await app.inject({ url: "/api/health" })).statusCode, 503);
  await admin.query("UPDATE schema_migrations SET checksum=$1 WHERE name=$2", [
    migration.checksum,
    migration.name,
  ]);
  assert.equal((await app.inject({ url: "/api/health" })).statusCode, 200);
  let calls = 0;
  await assert.rejects(
    deliverAccountLink(
      "fixture@example.com",
      "verify",
      "https://example.com",
      { NODE_ENV: "production", MAIL_MODE: "disabled" },
      (async () => {
        calls++;
        return new Response();
      }) as typeof fetch,
    ),
  );
  assert.equal(calls, 0);
  await admin.query("INSERT INTO installation_setup(token_hash) VALUES($1)", [
    digest(token),
  ]);
  assert.deepEqual((await app.inject({ url: "/api/setup/status" })).json(), {
    needsSetup: true,
    registrationEnabled: false,
  });
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin },
        payload: { email: "blocked@example.com", password },
      })
    ).statusCode,
    503,
  );
  assert.equal((await admin.query("SELECT * FROM users")).rowCount, 0);
  const setup = (t: string, headers = { origin }) =>
    app.inject({
      method: "POST",
      url: "/api/setup",
      headers,
      payload: { email: "owner@example.com", password, token: t },
    });
  assert.equal(
    (await setup(token, { origin: "https://attacker.invalid" })).statusCode,
    403,
  );
  assert.equal((await setup("0".repeat(64))).statusCode, 403);
  const race = await Promise.all([setup(token), setup(token)]);
  assert.deepEqual(race.map((r) => r.statusCode).sort(), [201, 403]);
  assert.equal(
    (await admin.query("SELECT * FROM platform_operators")).rowCount,
    1,
  );
  assert.equal(
    (await admin.query("SELECT * FROM installation_setup")).rowCount,
    0,
  );
  assert.equal(
    (await app.inject({ url: "/api/setup/status" })).json().needsSetup,
    false,
  );
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin },
    payload: { email: "owner@example.com", password },
  });
  assert.equal(login.statusCode, 200);
  const headers = {
    origin,
    cookie: login.cookies.map((c) => c.name + "=" + c.value).join("; "),
    "x-csrf-token": login.json().csrf,
  };
  const request = (url: string, method: any = "GET", payload?: any) =>
    app.inject({ url: "/api" + url, method, payload, headers });
  assert.equal((await request("/auth/me")).json().platformAdmin, true);
  assert.equal(
    (await app.inject({ url: "/api/admin/settings" })).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/api/admin/settings",
        headers: { origin, cookie: headers.cookie },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request("/admin/settings", "PUT", {
        password: "wrong",
        settings: {},
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await request("/admin/settings", "PUT", {
        password,
        settings: { APP_ENCRYPTION_KEY: "illegal" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await request("/admin/settings", "PUT", {
        password,
        settings: { MAIL_MODE: "resend" },
      })
    ).statusCode,
    400,
  );
  const keys = {
    RESEND_API_KEY: "mail-secret-fixture",
    AI_API_KEY: "ai-secret-fixture",
    TELEGRAM_BOT_TOKEN: "123:telegram_fixture",
    BILLING_WEBHOOK_SECRET: "billing-secret-fixture",
  };
  const saved = await request("/admin/settings", "PUT", {
    password,
    settings: {
      ...keys,
      MAIL_MODE: "resend",
      MAIL_FROM: "Trader <sender@example.com>",
      AI_PROVIDER: "openai",
      AI_MODEL: "fixture-model",
      AI_MAX_CALLS_PER_DAY: "8",
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.headers["cache-control"], "no-store");
  for (const secret of Object.values(keys))
    assert.ok(!saved.body.includes(secret));
  const ciphertext = (
    await admin.query("SELECT encrypted_value FROM platform_settings")
  ).rows[0].encrypted_value;
  for (const secret of Object.values(keys))
    assert.ok(!ciphertext.includes(secret));
  assert.equal((await runtimeConfiguration()).AI_API_KEY, keys.AI_API_KEY);
  assert.equal((await runtimeProvider())?.model, "fixture-model");
  assert.equal((await request("/ai/status")).json().ready, true);
  assert.equal(
    (await app.inject({ url: "/api/setup/status" })).json().registrationEnabled,
    true,
  );
  const transport = (async (_url: unknown, init: RequestInit) => {
    assert.equal(
      (init.headers as any).Authorization,
      "Bearer " + keys.RESEND_API_KEY,
    );
    calls++;
    return new Response(JSON.stringify({ id: "mail-fixture" }));
  }) as typeof fetch;
  await deliverAccountLink(
    "fixture@example.com",
    "verify",
    "https://example.com",
    undefined,
    transport,
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await request("/admin/settings", "PUT", {
        password,
        settings: { AI_MODEL: "changed" },
      })
    ).statusCode,
    200,
  );
  assert.equal((await runtimeConfiguration()).AI_API_KEY, keys.AI_API_KEY);
  const actor = randomUUID(),
    workspace = randomUUID(),
    session = randomUUID();
  await admin.query(
    "INSERT INTO users(id,email,password_hash,verified) VALUES($1,$2,'fixture',true)",
    [actor, actor + "@example.com"],
  );
  await admin.query("INSERT INTO workspaces(id,owner_id) VALUES($1,$2)", [
    workspace,
    actor,
  ]);
  await admin.query(
    "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,'csrf',now()+interval '1 hour')",
    [digest(session), actor],
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/admin/settings",
        headers: { cookie: "session=" + session },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/api/admin/settings",
        headers: {
          origin,
          cookie: "session=" + session,
          "x-csrf-token": "csrf",
        },
        payload: { password, settings: {} },
      })
    ).statusCode,
    403,
  );
  await assert.rejects(
    pool.query("INSERT INTO platform_operators(user_id) VALUES($1)", [actor]),
    /permission denied/,
  );
  await assert.rejects(
    pool.query("SELECT * FROM installation_setup"),
    /permission denied/,
  );
  assert.equal(
    (
      await request("/admin/settings", "PUT", {
        password,
        settings: {
          MAIL_MODE: "disabled",
          RESEND_API_KEY: "",
          AI_PROVIDER: "disabled",
          AI_API_KEY: "",
          TELEGRAM_BOT_TOKEN: "",
          BILLING_WEBHOOK_SECRET: "",
        },
      })
    ).statusCode,
    200,
  );
  assert.equal((await runtimeConfiguration()).AI_API_KEY, "");
  assert.equal(await runtimeProvider(), null);
  assert.equal(
    (await app.inject({ url: "/api/setup/status" })).json().registrationEnabled,
    false,
  );
  const audit = JSON.stringify(
    (
      await admin.query(
        "SELECT action,data FROM audit_logs WHERE action='PLATFORM_SETTINGS_CHANGED'",
      )
    ).rows,
  );
  for (const secret of Object.values(keys)) assert.ok(!audit.includes(secret));
  assert.ok(!audit.includes(password));
  const legacyExecutionFlag = process.env.TRADING_EXECUTION_ENABLED;
  process.env.TRADING_EXECUTION_ENABLED = "true";
  try {
    assert.equal(await testnetExecutionEnabled(), false);
  } finally {
    if (legacyExecutionFlag === undefined)
      delete process.env.TRADING_EXECUTION_ENABLED;
    else process.env.TRADING_EXECUTION_ENABLED = legacyExecutionFlag;
  }
  const control = (settings: unknown, acknowledgement = false) =>
    app.inject({
      url: "/api/admin/settings",
      method: "PUT",
      headers,
      remoteAddress: "192.0.2.55",
      payload: {
        password,
        settings,
        acknowledgeTestnetExecution: acknowledgement,
      },
    });
  assert.equal(
    (await control({ TRADING_EXECUTION_ENABLED: "true" })).statusCode,
    400,
  );
  assert.equal(await testnetExecutionEnabled(), false);
  assert.equal(
    (await control({ LIVE_TRADING_PLATFORM_ENABLED: "true" }, true)).statusCode,
    400,
  );
  const enabled = await control({ TRADING_EXECUTION_ENABLED: "true" }, true);
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal(enabled.json().TRADING_EXECUTION_ENABLED, "true");
  assert.equal(enabled.json().liveTradingEnabled, false);
  assert.equal(await testnetExecutionEnabled(admin), true);
  assert.equal(
    (await request("/trading/options")).json().executionEnabled,
    true,
  );
  assert.equal((await request("/ai/status")).json().executionEnabled, true);
  assert.equal(
    (await control({ TRADING_EXECUTION_ENABLED: "false" })).statusCode,
    200,
  );
  assert.equal(await testnetExecutionEnabled(admin), false);
  const changed = await admin.query(
    "SELECT data FROM audit_logs WHERE action='TESTNET_EXECUTION_CHANGED' ORDER BY id",
  );
  assert.deepEqual(
    changed.rows.map((row) => row.data.enabled),
    [true, false],
  );

  // Setup owner has a protected unlimited personal workspace; ordinary workspace admins do not.
  const me = (await request("/auth/me")).json(),
    ownerId =
      me.userId ??
      (
        await admin.query(
          "SELECT id FROM users WHERE email='owner@example.com'",
        )
      ).rows[0].id;
  const ownerWorkspace = me.tenantId;
  assert.equal((await request("/subscription")).json().plan, "UNLIMITED");
  assert.equal((await request("/subscription")).json().unlimited, true);
  assert.equal(
    (await admin.query("SELECT user_id FROM platform_owner")).rows[0].user_id,
    ownerId,
  );
  const directory = await request("/admin/users?limit=1&offset=0");
  assert.equal(directory.statusCode, 200, directory.body);
  assert.equal(directory.json().accounts.length, 1);
  assert.ok(directory.json().total >= 2);
  assert.equal(directory.body.includes("password_hash"), false);
  assert.equal(directory.body.includes("credentials"), false);
  const actorHeaders = {
    origin,
    cookie: "session=" + session,
    "x-csrf-token": "csrf",
  };
  assert.equal(
    (await app.inject({ url: "/api/admin/users", headers: actorHeaders }))
      .statusCode,
    403,
  );
  assert.equal((await app.inject({ url: "/api/admin/users" })).statusCode, 401);
  await assert.rejects(
    userContext(actor, (db) =>
      db.query("SELECT admin_account_directory('',25,0)"),
    ),
    /PLATFORM_ADMIN_REQUIRED/,
  );
  await assert.rejects(
    tenant(workspace, (db) =>
      db.query(
        "UPDATE subscriptions SET admin_plan_override='PRO' WHERE tenant_id=$1",
        [workspace],
      ),
    ),
    /permission denied/,
  );
  await assert.rejects(
    pool.query("UPDATE platform_owner SET user_id=$1", [actor]),
    /permission denied/,
  );
  const change = (plan: string | null, pw = password) =>
    request(`/admin/workspaces/${workspace}/plan`, "PATCH", {
      plan,
      password: pw,
    });
  assert.equal((await change("PRO", "wrong")).statusCode, 401);
  const planChanged = await change("PRO");
  assert.equal(planChanged.statusCode, 200, planChanged.body);
  assert.equal(
    (await tenant(workspace, (db) => entitlements(db, workspace))).plan,
    "PRO",
  );
  await admin.query(
    "UPDATE subscriptions SET plan='FREE',status='CANCELLED' WHERE tenant_id=$1",
    [workspace],
  );
  assert.equal(
    (await tenant(workspace, (db) => entitlements(db, workspace))).plan,
    "PRO",
    "Billing changes must not overwrite an admin assignment",
  );
  assert.equal((await change("FREE")).statusCode, 200);
  const free = await tenant(workspace, (db) => entitlements(db, workspace));
  assert.equal(free.plan, "FREE");
  assert.equal(free.unlimited, false);
  await tenant(workspace, async (db) => {
    await db.query(
      "INSERT INTO usage_records(tenant_id,metric,units,reference) VALUES($1,'ai',20,'admin-test-limit')",
      [workspace],
    );
  });
  await assert.rejects(
    tenant(workspace, (db) =>
      consume(db, workspace, "ai", "blocked-after-downgrade"),
    ),
    /MONTHLY_QUOTA_EXCEEDED/,
  );
  assert.equal((await change(null)).statusCode, 200);
  assert.equal(
    (await tenant(workspace, (db) => entitlements(db, workspace))).adminManaged,
    false,
  );
  assert.equal(
    (
      await request(`/admin/workspaces/${ownerWorkspace}/plan`, "PATCH", {
        plan: "FREE",
        password,
      })
    ).statusCode,
    409,
  );
  assert.equal((await request("/subscription")).json().unlimited, true);
  const noCsrf = await app.inject({
    url: `/api/admin/workspaces/${workspace}/plan`,
    method: "PATCH",
    headers: { origin, cookie: headers.cookie },
    payload: { plan: "PRO", password },
  });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(
    (
      await app.inject({
        url: `/api/admin/workspaces/${workspace}/plan`,
        method: "PATCH",
        headers: actorHeaders,
        payload: { plan: "PRO", password },
      })
    ).statusCode,
    403,
  );
  // Owner really exceeds the former PRO cap through the public bot API, not just a UI label.
  const connection = randomUUID();
  await tenant(ownerWorkspace, async (db) => {
    await db.query(
      "INSERT INTO exchange_connections(id,tenant_id,name,environment,credentials,status,permissions) VALUES($1,$2,'Owner fixture','TESTNET','fixture','CONNECTED','{}')",
      [connection, ownerWorkspace],
    );
    await db.query(
      "INSERT INTO usage_records(tenant_id,metric,units,reference) VALUES($1,'ai',100000,'owner-unlimited-check')",
      [ownerWorkspace],
    );
    await consume(db, ownerWorkspace, "ai", "owner-allowed");
  });
  for (let i = 0; i < 12; i++) {
    const created = await request("/bots", "POST", {
      name: `Unlimited bot ${i}`,
      connectionId: connection,
      config: { capital: 1, maxTrade: 1 },
    });
    assert.equal(created.statusCode, 201, created.body);
  }
  await admin.query(
    "UPDATE platform_settings SET encrypted_value=$1 WHERE singleton",
    [
      sealSettings({
        ...(await savedSettings(admin)),
        AI_PROVIDER: "openai",
        AI_MODEL: "gpt-4.1-mini",
        AI_API_KEY: "fixture-futures-key",
      }),
    ],
  );
  const futuresConfig = {
    name: "Owner futures",
    connectionId: connection,
    marketType: "LINEAR",
    leverage: 20,
    timeframe: "1440",
    strategyVersion: "ai-v1.0",
    aiStrategyConfig: { model: "gpt-4.1-mini", minConfidence: 70 },
    config: { capital: 100, maxTrade: 20 },
  };
  const future = await request("/bots", "POST", futuresConfig);
  assert.equal(future.statusCode, 201, future.body);
  const duplicate = await request("/bots", "POST", futuresConfig);
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  assert.equal(duplicate.json().error, "FUTURES_CONTRACT_ALREADY_ASSIGNED");
  const wrongStrategy = await request("/bots", "POST", {
    ...futuresConfig,
    symbol: "ETHUSDT",
    strategyVersion: "trend-v1.0",
  });
  assert.equal(wrongStrategy.statusCode, 400);
  const immutableMarket = await request(
    `/bots/${future.json().id}/config`,
    "PATCH",
    { marketType: "SPOT" },
  );
  assert.equal(immutableMarket.statusCode, 400);
  const futureMonitor = await request(`/bots/${future.json().id}/monitor`);
  assert.equal(futureMonitor.statusCode, 200, futureMonitor.body);
  assert.equal(futureMonitor.json().bot.market_type, "LINEAR");
  assert.equal(futureMonitor.json().bot.leverage, 20);
  assert.equal(futureMonitor.json().bot.timeframe, "1440");
  assert.equal(
    (
      await request(`/bots/${future.json().id}/config`, "PATCH", {
        leverage: 10,
        timeframe: "240",
      })
    ).statusCode,
    200,
  );
  const invalidLeverage = await request("/bots", "POST", {
    ...futuresConfig,
    symbol: "ETHUSDT",
    leverage: 21,
  });
  assert.equal(invalidLeverage.statusCode, 400);
  const unsafeStop = await request("/bots", "POST", {
    ...futuresConfig,
    symbol: "ETHUSDT",
    config: { capital: 100, maxTrade: 20, stopLossPct: 5 },
  });
  assert.equal(unsafeStop.statusCode, 400);
  const spotLeverage = await request("/bots", "POST", {
    name: "Spot",
    connectionId: connection,
    leverage: 2,
    config: {},
  });
  assert.equal(spotLeverage.statusCode, 400);
  const changes = (
    await admin.query(
      "SELECT data FROM audit_logs WHERE action='ADMIN_PLAN_CHANGED' ORDER BY id",
    )
  ).rows;
  assert.equal(changes.length, 3);
  assert.ok(changes.every((r) => r.data.actorUserId === ownerId));
  assert.equal(JSON.stringify(changes).includes(password), false);
  const searched = await request(`/admin/users?search=${actor}`);
  assert.equal(searched.statusCode, 200);
  assert.equal(searched.json().accounts[0].user_id, actor);
  console.log(
    "PASS: token-gated setup, concurrent claim, disabled signup, platform authorization, CSRF, password confirmation, encrypted/redacted settings, dynamic providers and key removal",
  );
} finally {
  await app.close();
  await pool.end();
  await closeIntelligence();
  await admin.end();
}
