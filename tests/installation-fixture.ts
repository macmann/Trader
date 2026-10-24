import assert from "node:assert/strict";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { app } from "../apps/api/src/server.ts";
import { pool } from "../apps/api/src/db.ts";
import {
  runtimeConfiguration,
  runtimeProvider,
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
  console.log(
    "PASS: token-gated setup, concurrent claim, disabled signup, platform authorization, CSRF, password confirmation, encrypted/redacted settings, dynamic providers and key removal",
  );
} finally {
  await app.close();
  await pool.end();
  await closeIntelligence();
  await admin.end();
}
