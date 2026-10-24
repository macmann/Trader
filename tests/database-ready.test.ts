import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { waitForDatabase } from "../scripts/database-ready.ts";
test("database startup retries are bounded and never expose credentials", async () => {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  const start = performance.now();
  await assert.rejects(
    waitForDatabase({
      connectionString: `postgresql://fixture:must-not-log@127.0.0.1:${port}/unavailable`,
      service: "test",
      timeoutMs: 120,
      retryMs: 15,
    }),
    (error) => {
      assert.match((error as Error).message, /DATABASE_STARTUP_TIMEOUT/);
      assert.ok(!(error as Error).message.includes("must-not-log"));
      return true;
    },
  );
  assert.ok(
    performance.now() - start >= 100,
    "should retry instead of failing immediately",
  );
  assert.ok(
    performance.now() - start < 2000,
    "must stop after the retry deadline",
  );
  await assert.rejects(
    waitForDatabase({ connectionString: undefined, service: "test" }),
    /CONFIGURATION_MISSING/,
  );
});

test("legacy Coolify Compose stays identical to the canonical deployment", async () => {
  assert.equal(
    await readFile("compose.coolify.yaml", "utf8"),
    await readFile("docker-compose.yaml", "utf8"),
  );
});
