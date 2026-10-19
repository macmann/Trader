import pg from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decrypt } from "../packages/core/src/index.ts";
import {
  exchangeAdapter,
  type ExchangeCredentials,
} from "../packages/exchanges/src/index.ts";
export async function publicProbe(transport: typeof fetch = fetch) {
  try {
    const r = await transport(
      "https://api-testnet.bybit.com/v5/market/instruments-info?category=spot&symbol=BTCUSDT",
      { signal: AbortSignal.timeout(15000) },
    );
    if (!r.ok)
      return {
        status: "BLOCKED",
        httpStatus: r.status,
        reason: "PUBLIC_ENDPOINT_ACCESS_FAILED",
      };
    const body = (await r.json()) as any;
    if (
      body?.retCode !== 0 ||
      !Array.isArray(body.result?.list) ||
      !body.result.list.some((x: any) => x.symbol === "BTCUSDT")
    )
      return { status: "BLOCKED", reason: "PUBLIC_DATA_INVALID" };
    return { status: "PASSED", httpStatus: r.status };
  } catch {
    return { status: "BLOCKED", reason: "PUBLIC_ENDPOINT_UNAVAILABLE" };
  }
}
export function assessPreflight(input: {
  publicStatus: string;
  rls: boolean;
  switchesOff: boolean;
  tenantCount: number;
  connections: { status: string }[];
}) {
  const blockers: string[] = [];
  if (input.publicStatus !== "PASSED") blockers.push("PUBLIC_TESTNET_ACCESS");
  if (!input.rls) blockers.push("RUNTIME_ROLE_MUST_ENFORCE_RLS");
  if (!input.switchesOff) blockers.push("KEEP_EXECUTION_AND_LIVE_SWITCHES_OFF");
  if (input.tenantCount < 2)
    blockers.push("TWO_INDEPENDENT_USER_WORKSPACES_REQUIRED");
  if (
    input.connections.length < 2 ||
    input.connections.some((c) => c.status !== "PASSED")
  )
    blockers.push("TWO_VALIDATED_TESTNET_CONNECTIONS_REQUIRED");
  return {
    preflightPassed: blockers.length === 0,
    acceptanceComplete: false,
    blockers,
    unverified: [
      "ACCOUNT_INDEPENDENCE",
      "AUTHENTICATED_PRIVATE_STREAMS",
      "ORDER_PLACEMENT_AND_FEES",
      "RESTART_AND_OUTAGE_EXCHANGE_ACCEPTANCE",
      "EXCHANGE_NATIVE_PROTECTION",
      "PRODUCTION_EMAIL_AND_OPERATIONS",
    ],
  };
}
export async function runPreflight() {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
    connections: {
      workspace: string;
      connection: string;
      provider: string;
      status: string;
      reason?: string;
    }[] = [];
  let rls = false,
    tenantCount = 0;
  const publicAccess = await publicProbe();
  try {
    const role = (
      await db.query(
        "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    rls = !!role && !role.rolsuper && !role.rolbypassrls;
    if (rls) {
      const workspaces = (
        await db.query(
          "SELECT id FROM workspaces WHERE kind='PERSONAL' ORDER BY id",
        )
      ).rows;
      for (let wi = 0; wi < workspaces.length; wi++) {
        const tid = workspaces[wi].id,
          client = await db.connect();
        try {
          await client.query("BEGIN READ ONLY");
          await client.query("SELECT set_config('app.tenant_id',$1,true)", [
            tid,
          ]);
          const stored = (
            await client.query(
              "SELECT id,provider,credentials,ledger_version FROM exchange_connections WHERE tenant_id=$1 AND environment='TESTNET' AND status='CONNECTED' AND credentials<>'' ORDER BY id",
              [tid],
            )
          ).rows;
          if (stored.length) tenantCount++;
          for (let ci = 0; ci < stored.length; ci++) {
            const c = stored[ci],
              result = {
                workspace: "workspace-" + (wi + 1),
                connection: "connection-" + (ci + 1),
                provider: c.provider,
                status: "BLOCKED",
                reason: "UNVERIFIED",
              };
            try {
              if (c.ledger_version !== 2) throw Error();
              const credentials = decrypt<ExchangeCredentials>(
                  c.credentials,
                  process.env.APP_ENCRYPTION_KEY!,
                  `${tid}:${c.id}:TESTNET`,
                ),
                adapter = exchangeAdapter(c.provider, "TESTNET", credentials);
              await adapter.validateCredentials();
              const balance = await adapter.getBalances(),
                orders = await adapter.getOpenOrders();
              if (
                !Array.isArray(balance.list?.[0]?.coin) ||
                !Array.isArray(orders.list)
              )
                throw Error();
              const unresolved = Number(
                (
                  await client.query(
                    "SELECT count(*) AS n FROM orders o JOIN bots b ON b.id=o.bot_id WHERE b.connection_id=$1 AND o.tenant_id=$2 AND o.state IN ('UNKNOWN','RECONCILING','SUBMITTING')",
                    [c.id, tid],
                  )
                ).rows[0].n,
              );
              if (unresolved) throw Error();
              result.status = "PASSED";
              result.reason = "READ_ONLY_CREDENTIAL_BALANCE_ORDER_CHECKS";
            } catch {
              result.reason = "CREDENTIAL_ACCESS_OR_LEDGER_REVIEW_REQUIRED";
            }
            connections.push(result);
          }
          await client.query("COMMIT");
        } catch {
          await client.query("ROLLBACK");
          throw Error("PREFLIGHT_DATABASE_READ_FAILED");
        } finally {
          client.release();
        }
      }
    }
    const assessment = assessPreflight({
      publicStatus: publicAccess.status,
      rls,
      switchesOff:
        process.env.TRADING_EXECUTION_ENABLED !== "true" &&
        process.env.LIVE_TRADING_PLATFORM_ENABLED !== "true",
      tenantCount,
      connections,
    });
    const report = {
      generatedAt: new Date().toISOString(),
      mode: "READ_ONLY_NO_ORDERS",
      publicAccess,
      runtimeRoleEnforcesRls: rls,
      workspacesWithTestnetConnections: tenantCount,
      connections,
      ...assessment,
    };
    const directory = resolve(import.meta.dirname, "../.local");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(directory, "testnet-preflight.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
    console.log(JSON.stringify(report, null, 2));
    return assessment.preflightPassed ? 0 : 2;
  } finally {
    await db.end();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await runPreflight();
  } catch {
    console.error(
      JSON.stringify({
        status: "BLOCKED",
        reason: "PREFLIGHT_RUNTIME_OR_DATABASE_UNAVAILABLE",
      }),
    );
    process.exitCode = 2;
  }
}
