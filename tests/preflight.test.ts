import { test } from "node:test";
import assert from "node:assert/strict";
import { assessPreflight, publicProbe } from "../scripts/testnet-preflight.ts";
test("read-only preflight never claims external acceptance from successful prerequisites", () => {
  const result = assessPreflight({
    publicStatus: "PASSED",
    rls: true,
    switchesOff: true,
    tenantCount: 2,
    connections: [{ status: "PASSED" }, { status: "PASSED" }],
  });
  assert.equal(result.preflightPassed, true);
  assert.equal(result.acceptanceComplete, false);
  assert.ok(result.unverified.includes("ORDER_PLACEMENT_AND_FEES"));
  const shared = assessPreflight({
    publicStatus: "PASSED",
    rls: true,
    switchesOff: true,
    tenantCount: 1,
    connections: [{ status: "PASSED" }, { status: "PASSED" }],
  });
  assert.equal(shared.preflightPassed, false);
  assert.ok(
    shared.blockers.includes("TWO_INDEPENDENT_USER_WORKSPACES_REQUIRED"),
  );
});
test("public preflight reports access denial without copying response bodies or secrets", async () => {
  const result = await publicProbe(
    (async () =>
      new Response("sensitive-response-fixture", {
        status: 403,
      })) as typeof fetch,
  );
  assert.equal(result.httpStatus, 403);
  assert.equal(result.status, "BLOCKED");
  assert.ok(!JSON.stringify(result).includes("sensitive-response"));
  const invalid = await publicProbe(
    (async () =>
      new Response(JSON.stringify({ retCode: 0, result: {} }))) as typeof fetch,
  );
  assert.equal(invalid.status, "BLOCKED");
  const good = await publicProbe(
    (async () =>
      new Response(
        JSON.stringify({
          retCode: 0,
          result: { list: [{ symbol: "BTCUSDT" }] },
        }),
      )) as typeof fetch,
  );
  assert.equal(good.status, "PASSED");
});
