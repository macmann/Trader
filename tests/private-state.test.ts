import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateFeedState } from "../apps/worker/src/private-state.ts";
const msg = (v: any) => JSON.stringify(v);
function bybit(now = 1000) {
  const s = new PrivateFeedState("BYBIT");
  s.receive(msg({ op: "auth", success: true }), now);
  s.receive(
    msg({ op: "subscribe", success: true, req_id: "private-subscriptions" }),
    now,
  );
  return s;
}
test("Bybit requires matching subscription confirmation after authentication and expires readiness", () => {
  const s = new PrivateFeedState("BYBIT");
  s.receive(msg({ op: "auth", success: true }), 1000);
  assert.equal(s.ready(1001), false);
  s.receive(
    msg({ op: "subscribe", success: true, req_id: "private-subscriptions" }),
    1002,
  );
  assert.equal(s.ready(1003), true);
  assert.equal(s.ready(1001), false);
  assert.equal(s.ready(46002), false);
  s.receive(msg({ op: "ping", success: true, ret_msg: "pong" }), 46003);
  assert.equal(s.ready(46004), true);
});
test("private errors, rejected subscriptions and disconnect invalidate authenticated readiness", () => {
  for (const payload of [
    { op: "subscribe", success: false },
    { op: "auth", success: false },
    { op: "subscribe", success: true, req_id: "unrelated" },
    { success: false },
    null,
  ]) {
    const s = bybit();
    s.receive(msg(payload), 1001);
    assert.equal(s.ready(1002), false);
    assert.equal(s.failed, true);
  }
  const s = bybit();
  s.invalidate();
  assert.equal(s.ready(1001), false);
});
test("unknown traffic cannot refresh readiness and account events advance the reconciliation revision", () => {
  const s = bybit();
  const before = s.revision;
  s.receive(msg({ topic: "order", data: [{ orderId: "1" }] }), 1001);
  assert.equal(s.revision, before + 1);
  assert.equal(s.ready(1002), true);
  s.receive(msg({ arbitrary: "traffic" }), 45000);
  assert.equal(s.ready(46002), false);
  s.receive(msg({ topic: "execution", data: "malformed" }), 46003);
  assert.equal(s.failed, true);
});
test("OKX requires both Spot order and account subscription acknowledgements", () => {
  const s = new PrivateFeedState("OKX");
  s.receive("pong", 100);
  assert.equal(s.authenticated, false);
  s.receive(msg({ event: "login", code: "0" }), 1000);
  s.receive(
    msg({ event: "subscribe", arg: { channel: "orders", instType: "SPOT" } }),
    1001,
  );
  assert.equal(s.ready(1002), false);
  s.receive(msg({ event: "subscribe", arg: { channel: "account" } }), 1002);
  assert.equal(s.ready(1003), true);
  s.receive("pong", 45000);
  assert.equal(s.ready(45001), true);
  s.receive(msg({ arg: { channel: "account" }, data: [] }), 45002);
  assert.equal(s.revision, 1);
  s.receive(msg({ event: "error", code: "60012" }), 45003);
  assert.equal(s.ready(45004), false);
});

test("EU Testnet private events use Bybit authentication and subscription readiness", () => {
  const s = new PrivateFeedState("BYBIT_EU_TESTNET");
  assert.equal(
    s.receive(msg({ op: "auth", success: true }), 1000),
    "AUTHENTICATED",
  );
  assert.equal(s.ready(1001), false);
  s.receive(
    msg({ op: "subscribe", success: true, req_id: "private-subscriptions" }),
    1002,
  );
  assert.equal(s.ready(1003), true);
  s.invalidate();
  assert.equal(s.ready(1004), false);
});
