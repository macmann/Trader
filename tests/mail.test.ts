import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateMailConfiguration,
  validatePublicOrigin,
  deliverAccountLink,
} from "../apps/api/src/mail.ts";
const env = {
  NODE_ENV: "production",
  MAIL_MODE: "resend",
  RESEND_API_KEY: "transport-fixture-only",
  MAIL_FROM: "Trader <accounts@example.com>",
  APP_ORIGIN: "https://trader.example",
};
test("production requires HTTPS origin and a configured transactional transport", () => {
  assert.equal(validatePublicOrigin(env), "https://trader.example");
  validateMailConfiguration(env);
  for (const value of [
    "http://trader.example",
    "https://trader.example/path",
    "https://trader.example/",
    "https://user:password@trader.example",
  ])
    assert.throws(() => validatePublicOrigin({ ...env, APP_ORIGIN: value }));
  assert.throws(() =>
    validateMailConfiguration({ ...env, MAIL_MODE: "development" }),
  );
  assert.throws(() =>
    validateMailConfiguration({ ...env, RESEND_API_KEY: "" }),
  );
  assert.throws(() =>
    validateMailConfiguration({ ...env, MAIL_FROM: "invalid\r\nInjected" }),
  );
});
test("Resend delivers verification/reset links only server-side through a fixed TLS endpoint", async () => {
  const requests: any[] = [];
  const transport = (async (url: any, init: any) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "fixture-mail" }));
  }) as typeof fetch;
  await deliverAccountLink(
    "user@example.com",
    "verify",
    "https://trader.example/?verify=fixture-token",
    env,
    transport,
  );
  await deliverAccountLink(
    "user@example.com",
    "reset",
    "https://trader.example/?reset=fixture-token",
    env,
    transport,
  );
  assert.equal(requests[0].url, "https://api.resend.com/emails");
  assert.equal(
    requests[0].init.headers.Authorization,
    "Bearer transport-fixture-only",
  );
  assert.deepEqual(requests[0].body.to, ["user@example.com"]);
  assert.ok(requests[0].body.text.includes("?verify=fixture-token"));
  assert.ok(requests[1].body.text.includes("?reset=fixture-token"));
  assert.ok(!JSON.stringify(requests[0].body).includes(env.RESEND_API_KEY));
});
test("mail transport failures never echo provider bodies, keys or verification links", async () => {
  for (const transport of [
    async () => new Response("secret-provider-body", { status: 401 }),
    async () => {
      throw Error("secret-network-detail");
    },
    async () => new Response("{}"),
  ]) {
    await assert.rejects(
      deliverAccountLink(
        "user@example.com",
        "verify",
        "https://trader.example/?verify=secret-link",
        env,
        transport as typeof fetch,
      ),
      (error) => {
        assert.equal((error as Error).message, "EMAIL_DELIVERY_UNAVAILABLE");
        return true;
      },
    );
  }
});
