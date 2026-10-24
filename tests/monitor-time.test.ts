import { test } from "node:test";
import assert from "node:assert/strict";
import { monitorTime } from "../apps/web/src/monitor-time.ts";
test("bot monitoring formats numeric event timestamps and ISO database dates consistently", () => {
  const time = Date.UTC(2026, 9, 24, 12, 30);
  assert.equal(monitorTime(time), new Date(time).toLocaleString());
  assert.equal(monitorTime(new Date(time).toISOString()), monitorTime(time));
  for (const value of [
    undefined,
    null,
    0,
    "",
    NaN,
    Infinity,
    "invalid-date",
    {},
    [],
  ])
    assert.equal(monitorTime(value), "Not recorded");
});
