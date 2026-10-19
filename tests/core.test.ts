import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  encrypt,
  decrypt,
  botConfig,
  risk,
  quantize,
  evaluate,
  BybitAdapter,
  ExchangeError,
} from "../packages/core/src/index.ts";
test("AES-GCM encrypts credentials and binds ciphertext to tenant, connection and environment", () => {
  const key = randomBytes(32).toString("hex"),
    secret = { apiSecret: "sensitive-value" },
    cipher = encrypt(secret, key, "tenantA:conn1:TESTNET");
  assert.ok(!cipher.includes(secret.apiSecret));
  assert.deepEqual(decrypt(cipher, key, "tenantA:conn1:TESTNET"), secret);
  assert.throws(() => decrypt(cipher, key, "tenantB:conn1:TESTNET"));
  assert.throws(() => decrypt(cipher, key, "tenantA:conn1:LIVE"));
  const bytes = Buffer.from(cipher, "base64");
  bytes[30] ^= 1;
  assert.throws(() =>
    decrypt(bytes.toString("base64"), key, "tenantA:conn1:TESTNET"),
  );
});
test("invalid allocation and missing stop-loss rejected", () => {
  assert.equal(
    botConfig.safeParse({ capital: 10, maxTrade: 20 }).success,
    false,
  );
  assert.equal(botConfig.safeParse({ stopLossPct: 0 }).success, false);
});
const baseline = {
  config: botConfig.parse({}),
  status: "RUNNING",
  environment: "TESTNET",
  liveEnabled: false,
  connected: true,
  fresh: true,
  reconciled: true,
  globalStop: false,
  exposure: 0,
  dailyPnl: 0,
  trades: 0,
  drawdownPct: 0,
  consecutiveLosses: 0,
  available: 100,
  spreadPct: 0.1,
};
test("valid Testnet candidate passes risk gates", () =>
  assert.deepEqual(risk(baseline), []));
for (const [patch, reason] of [
  [{ status: "STOPPED" }, "BOT_NOT_RUNNING"],
  [{ environment: "LIVE" }, "LIVE_DISABLED"],
  [{ fresh: false }, "STALE_MARKET_DATA"],
  [{ connected: false }, "EXCHANGE_DISCONNECTED"],
  [{ globalStop: true }, "GLOBAL_STOP"],
  [{ reconciled: false }, "RECONCILIATION_REQUIRED"],
  [{ exposure: 90 }, "ALLOCATION_EXCEEDED"],
  [{ available: 19 }, "INSUFFICIENT_BALANCE"],
  [{ dailyPnl: -5 }, "DAILY_LOSS_LIMIT"],
  [{ trades: 10 }, "DAILY_TRADE_LIMIT"],
  [{ drawdownPct: 10 }, "DRAWDOWN_LIMIT"],
  [{ consecutiveLosses: 3 }, "CONSECUTIVE_LOSS_LIMIT"],
  [{ spreadPct: 0.31 }, "SPREAD_TOO_WIDE"],
] as const)
  test(`risk veto: ${reason}`, () =>
    assert.ok(risk({ ...baseline, ...patch }).includes(reason)));
test("decimal quantity rounds down to exchange step without float drift", () => {
  assert.equal(quantize("0.000299999999999", "0.00001"), "0.00029");
  assert.equal(quantize("1.23", "0.1"), "1.2");
});
test("strategy waits for warmup and exits bearish trends", () => {
  assert.equal(evaluate([]).direction, "NONE");
  const candles = Array.from({ length: 70 }, (_, i) => ({
    time: i,
    open: 100 - i,
    high: 101 - i,
    low: 99 - i,
    close: 100 - i,
    volume: 100,
  }));
  assert.equal(evaluate(candles).direction, "EXIT");
});
test("Bybit refuses dangerous API permissions and separates environments", async () => {
  const adapter = new BybitAdapter("TESTNET", {
    apiKey: "key",
    apiSecret: "secret",
  });
  adapter.request = async () => ({
    readOnly: 0,
    permissions: { Spot: ["SpotTrade"], Wallet: ["Withdraw"] },
  });
  await assert.rejects(
    adapter.validateCredentials(),
    (e: unknown) =>
      e instanceof ExchangeError && e.status === "PERMISSION_ERROR",
  );
  assert.equal(adapter.base, "https://api-testnet.bybit.com");
  assert.equal(new BybitAdapter("LIVE").base, "https://api.bybit.com");
});

test("non-finite risk state never bypasses exposure, balance or loss checks", () => {
  for (const patch of [
    { available: NaN },
    { dailyPnl: Infinity },
    { exposure: NaN },
    { spreadPct: NaN },
  ])
    assert.deepEqual(risk({ ...baseline, ...patch }), ["INVALID_RISK_STATE"]);
});
