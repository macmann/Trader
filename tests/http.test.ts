import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonRequestOptions } from "../apps/web/src/http.ts";
test("bodyless actions retain CSRF without declaring an empty JSON document", () => {
  const request = jsonRequestOptions("POST", "fixture-csrf");
  assert.equal(request.body, undefined);
  assert.equal(request.headers["Content-Type"], undefined);
  assert.equal(request.headers["X-CSRF-Token"], "fixture-csrf");
});
test("JSON payloads preserve false, zero, null and objects with matching content type", () => {
  for (const value of [false, 0, null, { setting: true }]) {
    const request = jsonRequestOptions("POST", "fixture-csrf", value);
    assert.equal(request.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(request.body!), value);
  }
});
