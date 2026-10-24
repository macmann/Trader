import { waitForDatabase } from "./database-ready.ts";
import { readFile } from "node:fs/promises";
const mode = process.argv[2];
if (!["web", "worker", "migrate", "preflight"].includes(mode))
  throw Error("Invalid service mode");
const database = process.env.POSTGRES_DB ?? "trader";
const administrator = process.env.POSTGRES_USER ?? "trader_admin";
const runtime = process.env.APP_DATABASE_USER ?? "trader_app";
for (const value of [database, administrator, runtime]) {
  if (!value || Buffer.byteLength(value) > 63 || value.includes("\0"))
    throw Error("Invalid bundled database identifier");
}
if (runtime === administrator)
  throw Error("Runtime and migration database roles must differ");
const password = (
  await readFile("/run/app-secrets/database-password", "utf8")
).trim();
if (!/^[a-f0-9]{64}$/.test(password))
  throw Error("Invalid installation credential file");
process.env.DATABASE_URL = `postgresql://${encodeURIComponent(runtime)}:${password}@postgres:5432/${encodeURIComponent(database)}`;
if (mode === "migrate") {
  const admin = (
    await readFile("/run/admin-secrets/database-password", "utf8")
  ).trim();
  if (!/^[a-f0-9]{64}$/.test(admin))
    throw Error("Invalid installation credential file");
  process.env.DATABASE_ADMIN_URL = `postgresql://${encodeURIComponent(administrator)}:${admin}@postgres:5432/${encodeURIComponent(database)}`;
  process.env.APP_DATABASE_USER = runtime;
  process.env.BUNDLED_DATABASE = "true";
  await import("./deploy-migrate.ts");
} else if (mode === "preflight") {
  try {
    process.exitCode = await (
      await import("./testnet-preflight.ts")
    ).runPreflight();
  } catch {
    console.error(
      JSON.stringify({
        status: "BLOCKED",
        reason: "PREFLIGHT_RUNTIME_OR_DATABASE_UNAVAILABLE",
      }),
    );
    process.exitCode = 2;
  }
} else if (mode === "web") {
  await waitForDatabase({
    connectionString: process.env.DATABASE_URL,
    service: mode,
    requireSchema: true,
  });
  process.env.INSTALLATION_SETUP_ENABLED = "true";
  await import("../apps/api/src/server.ts");
} else {
  await waitForDatabase({
    connectionString: process.env.DATABASE_URL,
    service: mode,
    requireSchema: true,
  });
  await import("../apps/worker/src/index.ts");
}
