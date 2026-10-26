import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RetryPolicy,
  transientExchangeFailure,
} from "../apps/worker/src/retry-policy.ts";
import {
  ExchangeError,
  definitiveOrderRejection,
} from "../packages/core/src/index.ts";
test("exchange backoff is connection scoped, exponential, bounded and resets after success", () => {
  const retry = new RetryPolicy();
  assert.equal(retry.failure("account-a", 0), 30000);
  assert.equal(retry.ready("account-a", 29999), false);
  assert.equal(retry.ready("account-b", 1), true);
  assert.equal(retry.failure("account-a", 30000), 90000);
  for (let i = 0; i < 10; i++) retry.failure("account-a", 0);
  assert.equal(retry.failure("account-a", 0), 300000);
  retry.success("account-a");
  assert.equal(retry.failure("account-a", 0), 30000);
  for (const code of [429, 503, 502])
    assert.equal(
      transientExchangeFailure(
        new ExchangeError(
          code,
          code === 429 ? "RATE_LIMITED" : "EXCHANGE_HTTP_ERROR",
        ),
      ),
      true,
    );
  assert.equal(
    transientExchangeFailure(new ExchangeError(403, "REGION_RESTRICTED")),
    false,
  );
  assert.equal(
    transientExchangeFailure(Error("UNEXPECTED_FUTURES_POSITION")),
    false,
  );
});
test("only definitive order validation failures are terminal; duplicate IDs/timeouts remain uncertain", () => {
  assert.equal(
    definitiveOrderRejection(new ExchangeError(51008, "ORDER_REJECTED")),
    true,
  );
  for (const code of [50004, 51016, 0])
    assert.equal(
      definitiveOrderRejection(new ExchangeError(code, "ORDER_REJECTED")),
      false,
    );
});
