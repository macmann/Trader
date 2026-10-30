import { test } from "node:test";
import assert from "node:assert/strict";
import { workerHealth } from "../packages/core/src/worker-health.ts";
import { summarizeDiagnostics } from "../apps/api/src/bot-diagnostics.ts";
test("bounded scheduled backoff is distinct from a fresh check or an overdue worker", () => {
  const now = Date.now(),
    monitor = {
      checked_at: new Date(now - 240000),
      snapshot: { stage: "RISK_LOCKED", retryAt: now + 60000 },
    };
  assert.deepEqual(workerHealth(monitor, now), {
    recent: false,
    waiting: true,
    stale: false,
  });
  assert.equal(workerHealth(monitor, now + 91000).stale, true);
  assert.equal(
    workerHealth(
      { ...monitor, snapshot: { ...monitor.snapshot, retryAt: now + 3600000 } },
      now,
    ).stale,
    true,
  );
  assert.equal(workerHealth(null, now).stale, true);
  const findings = summarizeDiagnostics(
    { status: "STOPPED" },
    monitor,
    [],
    { fills: 0, orders: 1 },
    now,
  ).join(" ");
  assert.match(findings, /scheduled retry/);
  assert.doesNotMatch(findings, /No recent worker observation/);
});
