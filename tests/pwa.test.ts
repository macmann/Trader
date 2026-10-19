import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
async function harness() {
  const handlers: Record<string, Function> = {},
    writes: string[] = [],
    cache = {
      addAll: async (paths: string[]) => {
        writes.push(...paths);
      },
      put: async (req: any) => {
        writes.push(req.url);
      },
    };
  const context = {
    self: {
      location: { origin: "https://trader.example" },
      clients: { claim: async () => {} },
      addEventListener: (name: string, handler: Function) => {
        handlers[name] = handler;
      },
    },
    caches: {
      open: async () => cache,
      keys: async () => [],
      delete: async () => true,
      match: async (path: any) =>
        path === "/offline.html" ? new Response("offline") : undefined,
    },
    URL,
    fetch: async () => new Response("static"),
  };
  vm.runInNewContext(await readFile("apps/web/public/sw.js", "utf8"), context);
  return { handlers, writes, context };
}
test("PWA cache excludes account APIs, mutation requests and other origins", async () => {
  const h = await harness();
  for (const request of [
    { method: "GET", url: "https://trader.example/api/bots" },
    { method: "POST", url: "https://trader.example/api/stop-all" },
    { method: "GET", url: "https://other.example/assets/secret.js" },
  ]) {
    let handled = false;
    h.handlers.fetch({
      request,
      respondWith: () => {
        handled = true;
      },
    });
    assert.equal(handled, false);
  }
  assert.deepEqual(h.writes, []);
});
test("PWA offline navigation shows reconnect content without caching authenticated navigation", async () => {
  const h = await harness();
  h.context.fetch = async () => {
    throw Error("offline");
  };
  let response: Promise<Response> | undefined;
  h.handlers.fetch({
    request: {
      method: "GET",
      url: "https://trader.example/",
      mode: "navigate",
    },
    respondWith: (p: Promise<Response>) => {
      response = p;
    },
  });
  assert.equal(await (await response!).text(), "offline");
  assert.deepEqual(h.writes, []);
});
test("PWA install caches only the public offline page and icon", async () => {
  const h = await harness();
  let work: Promise<any> | undefined;
  h.handlers.install({
    waitUntil: (p: Promise<any>) => {
      work = p;
    },
  });
  await work;
  assert.deepEqual(h.writes, ["/offline.html", "/icon.svg"]);
  const manifest = JSON.parse(
    await readFile("apps/web/public/manifest.webmanifest", "utf8"),
  );
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
});
