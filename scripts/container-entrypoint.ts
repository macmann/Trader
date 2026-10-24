import { readFile } from "node:fs/promises";
const mode = process.argv[2];
if (!["web", "worker", "migrate", "preflight"].includes(mode))
  throw Error("Invalid service mode");
const password = (
  await readFile("/run/app-secrets/database-password", "utf8")
).trim();
if (!/^[a-f0-9]{64}$/.test(password))
  throw Error("Invalid installation credential file");
process.env.DATABASE_URL = `postgresql://trader_app:${password}@postgres:5432/trader`;
if (mode === "migrate") {
  const admin = (
    await readFile("/run/admin-secrets/database-password", "utf8")
  ).trim();
  if (!/^[a-f0-9]{64}$/.test(admin))
    throw Error("Invalid installation credential file");
  process.env.DATABASE_ADMIN_URL = `postgresql://trader_admin:${admin}@postgres:5432/trader`;
  process.env.APP_DATABASE_USER = "trader_app";
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
  process.env.INSTALLATION_SETUP_ENABLED = "true";
  await import("../apps/api/src/server.ts");
} else await import("../apps/worker/src/index.ts");
