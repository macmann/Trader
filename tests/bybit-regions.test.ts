import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { BybitAdapter, ExchangeError } from "../packages/core/src/index.ts";
import {
  exchangeAdapter,
  bybitTestnetEndpoints,
} from "../packages/exchanges/src/index.ts";
const credentials = {
  apiKey: "regional-fixture-key",
  apiSecret: "regional-fixture-secret",
};
const reply = (result: unknown) =>
  new Response(JSON.stringify({ retCode: 0, result }));
test("EU read-only credentials use only the official EU endpoint and cannot submit or cancel orders", async () => {
  const calls: string[] = [];
  const transport = (async (input: any, init: any) => {
    const url = new URL(input);
    calls.push(input);
    assert.equal(url.origin, "https://api.bybit.eu");
    assert.equal(init.method, "GET");
    const h = init.headers;
    assert.equal(
      h["X-BAPI-SIGN"],
      createHmac("sha256", credentials.apiSecret)
        .update(
          h["X-BAPI-TIMESTAMP"] +
            credentials.apiKey +
            h["X-BAPI-RECV-WINDOW"] +
            url.search.slice(1),
        )
        .digest("hex"),
    );
    return reply(
      url.pathname === "/v5/user/query-api"
        ? { readOnly: 1, permissions: {}, ips: ["192.0.2.1"] }
        : { list: [] },
    );
  }) as typeof fetch;
  const adapter = new BybitAdapter("LIVE", credentials, "EU", transport);
  const permissions = await adapter.validateCredentials();
  assert.equal(permissions.trading, false);
  assert.equal(permissions.readOnly, true);
  const reads = calls.length;
  await assert.rejects(
    adapter.request("/v5/order/create", {}, "POST"),
    /LIVE_TRADING_DISABLED/,
  );
  await assert.rejects(
    adapter.cancelOrder("BTCUSDT", "fixture-order"),
    /LIVE_TRADING_DISABLED/,
  );
  assert.equal(calls.length, reads);
  assert.throws(
    () => exchangeAdapter("BYBIT_EU", "TESTNET", credentials),
    /REQUIRES_LIVE_ENVIRONMENT/,
  );
  assert.throws(
    () => exchangeAdapter("BYBIT", "LIVE", credentials),
    /LIVE_DISABLED/,
  );
});
test("EU rejects trading or transfer-capable keys; Testnet still requires Spot trading permission", async () => {
  for (const result of [
    { readOnly: 0, permissions: { Spot: ["SpotTrade"] } },
    { readOnly: 1, permissions: { Wallet: ["AccountTransfer"] } },
    { readOnly: 1, permissions: { Fund: ["any"] } },
  ]) {
    const adapter = new BybitAdapter("LIVE", credentials, "EU", (async () =>
      reply(result)) as typeof fetch);
    await assert.rejects(
      adapter.validateCredentials(),
      /READ_ONLY_API_KEY_REQUIRED|PERMISSION_ERROR/,
    );
  }
  const adapter = new BybitAdapter("TESTNET", credentials, "GLOBAL", (async (
    url: any,
  ) => {
    assert.equal(new URL(url).origin, "https://api-testnet.bybit.com");
    return reply({ readOnly: 0, permissions: { Spot: ["SpotTrade"] } });
  }) as typeof fetch);
  assert.equal((await adapter.validateCredentials()).trading, true);
});
test("Bybit authentication diagnostics retain only numeric codes and safe statuses, without retrying other domains", async () => {
  for (const [code, status] of [
    [10002, "EXCHANGE_CLOCK_SKEW"],
    [10003, "API_KEY_OR_ENVIRONMENT_MISMATCH"],
    [10004, "INVALID_SIGNATURE"],
    [10005, "PERMISSION_ERROR"],
    [10010, "IP_BINDING_ERROR"],
    [33004, "API_KEY_EXPIRED"],
  ] as const) {
    let calls = 0;
    const adapter = new BybitAdapter(
      "TESTNET",
      credentials,
      "GLOBAL",
      (async () => {
        calls++;
        return new Response(
          JSON.stringify({
            retCode: code,
            retMsg: "never expose " + credentials.apiSecret,
          }),
        );
      }) as typeof fetch,
    );
    await assert.rejects(adapter.validateCredentials(), (error) => {
      assert.ok(error instanceof ExchangeError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.ok(!error.message.includes(credentials.apiSecret));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("EU Testnet REST and private/public streams stay separate from global Testnet and EU mainnet", async () => {
  const requests: string[] = [];
  const adapter = new BybitAdapter("TESTNET", credentials, "EU", (async (
    input: any,
  ) => {
    const url = new URL(input);
    requests.push(url.origin);
    assert.equal(url.origin, "https://api-testnet.bybit.eu");
    return reply(
      url.pathname === "/v5/user/query-api"
        ? { readOnly: 0, permissions: { Spot: ["SpotTrade"] } }
        : { list: [] },
    );
  }) as typeof fetch);
  assert.equal((await adapter.validateCredentials()).trading, true);
  assert.equal(requests.length, 2);
  const selected = exchangeAdapter(
    "BYBIT_EU_TESTNET",
    "TESTNET",
    credentials,
  ) as BybitAdapter;
  assert.equal(selected.base, "https://api-testnet.bybit.eu");
  assert.throws(
    () => exchangeAdapter("BYBIT_EU_TESTNET", "LIVE", credentials),
    /LIVE_DISABLED/,
  );
  assert.deepEqual(bybitTestnetEndpoints("BYBIT_EU_TESTNET"), {
    public: "wss://stream-testnet.bybit.eu/v5/public/spot",
    private: "wss://stream-testnet.bybit.eu/v5/private",
  });
  assert.equal(
    bybitTestnetEndpoints("BYBIT").private,
    "wss://stream-testnet.bybit.com/v5/private",
  );
});
