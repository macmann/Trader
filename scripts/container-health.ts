import { stat } from "node:fs/promises";
try {
  if (process.argv[2] === "worker") {
    const info = await stat("/tmp/trader-worker-heartbeat");
    if (Date.now() - info.mtimeMs > 120000) throw Error();
  } else {
    const r = await fetch("http://127.0.0.1:3000/api/health", {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw Error();
    const body = (await r.json()) as any;
    if (body.status !== "ok" || body.liveTrading !== false) throw Error();
  }
} catch {
  process.exitCode = 1;
}
