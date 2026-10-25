import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tenant } from "./db.ts";
import { testnetExecutionEnabled } from "./installation.ts";
const MAX = 500;
export function redactDiagnostics(value: unknown): any {
  if (Array.isArray(value)) return value.map(redactDiagnostics);
  if (value && typeof value === "object" && !(value instanceof Date))
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/(secret|credential|password|api.?key|encrypted|cookie|authorization|token|headers|^raw$)/i.test(
              key,
            ),
        )
        .map(([k, v]) => [k, redactDiagnostics(v)]),
    );
  return value;
}
export function summarizeDiagnostics(
  bot: any,
  monitor: any,
  signals: any[],
  counts: Record<string, number>,
  now = Date.now(),
) {
  const findings: string[] = [];
  if (!monitor || now - new Date(monitor.checked_at).getTime() > 120000)
    findings.push(
      "No recent worker observation. Check the worker container and exchange connectivity.",
    );
  if (bot.status !== "RUNNING")
    findings.push(`Bot status is ${bot.status}; it is not currently running.`);
  if (counts.fills === 0)
    findings.push(
      "No exchange fills were recorded in the selected period. This does not prove that no earlier trade occurred.",
    );
  if (counts.orders > 0 && counts.fills === 0)
    findings.push(
      "Orders exist without recorded fills in this period. Inspect order states, cancellations, events and reconciliation.",
    );
  const latest = signals[0];
  if (latest) {
    if (latest.data?.direction === "NONE")
      findings.push(
        "Latest evaluated candle produced no entry or exit signal. Inspect strategy reasons and individual rule checks.",
      );
    else if (latest.data?.direction === "EXIT" && !latest.decision?.approved)
      findings.push(
        "Latest signal requested an exit, but no exit was approved. An exit signal with no bot-owned position cannot open a trade.",
      );
    else if (!latest.decision?.approved)
      findings.push(
        `Latest entry was not approved: ${(latest.decision?.reasons ?? []).join(", ") || "inspect its decision and order events"}.`,
      );
    else
      findings.push(
        "Latest signal was approved; approval is not proof of an exchange fill. Follow its order and fill history.",
      );
  } else
    findings.push(
      "No strategy evaluations were recorded in this period. Check worker states, data readiness, candle cadence and execution controls.",
    );
  if (latest?.data?.reasons?.length)
    findings.push(
      `Latest strategy reasons: ${latest.data.reasons.join(", ")}.`,
    );
  if (monitor?.snapshot?.reasons?.length)
    findings.push(
      `Latest worker state: ${monitor.snapshot.stage} (${monitor.snapshot.reasons.join(", ")}).`,
    );
  return findings;
}
export function registerBotDiagnostics(app: FastifyInstance) {
  app.get(
    "/api/bots/:id/diagnostics",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const id = z.uuid().parse((req.params as { id: string }).id),
        { hours } = z
          .object({
            hours: z.coerce.number().int().min(1).max(336).default(24),
          })
          .parse(req.query),
        tid = req.identity!.tenantId;
      return tenant(tid, async (db) => {
        const bot = (
          await db.query(
            "SELECT b.id,b.name,b.status,b.symbol,b.timeframe,b.strategy_version,b.config,b.advanced_config,b.ai_mode,b.ai_strategy_config,b.custom_strategy_id,b.last_candle,b.created_at,c.id AS connection_id,c.provider,c.environment,c.status AS connection_status,c.reconciled_at FROM bots b JOIN exchange_connections c ON c.id=b.connection_id AND c.tenant_id=b.tenant_id WHERE b.id=$1 AND b.tenant_id=$2",
            [id, tid],
          )
        ).rows[0];
        if (!bot) return reply.code(404).send({ error: "NOT_FOUND" });
        const generatedAt = new Date(),
          since = new Date(generatedAt.getTime() - hours * 3600000);
        const current =
          (
            await db.query(
              "SELECT checked_at,last_success_at,snapshot,error_snapshot,error_at,price,price_at FROM bot_monitoring WHERE bot_id=$1 AND tenant_id=$2",
              [id, tid],
            )
          ).rows[0] ?? null;
        const position =
          (
            await db.query(
              "SELECT quantity,cost,fees,realized_pnl,updated_at,high_watermark,entry_count FROM positions WHERE bot_id=$1 AND tenant_id=$2",
              [id, tid],
            )
          ).rows[0] ?? null;
        const inventory = (
          await db.query(
            "SELECT asset,external_quantity,last_total,captured_at,last_checked_at FROM connection_inventory WHERE connection_id=$1 AND tenant_id=$2",
            [bot.connection_id, tid],
          )
        ).rows;
        const customStrategy = bot.custom_strategy_id
          ? (
              await db.query(
                "SELECT id,name,version,rules,created_at FROM custom_strategies WHERE id=$1 AND tenant_id=$2",
                [bot.custom_strategy_id, tid],
              )
            ).rows[0]
          : null;
        const executionEnabled = await testnetExecutionEnabled(db),
          globalStop = (
            await db.query(
              "SELECT execution_stopped FROM platform_controls WHERE id=true",
            )
          ).rows[0].execution_stopped;
        const specs: Record<
          string,
          { from: string; where: string; time: string; fields: string }
        > = {
          signals: {
            from: "signals x",
            where: "x.bot_id=$1 AND x.tenant_id=$2",
            time: "x.created_at",
            fields:
              "x.id,x.candle_time,x.strategy_version,x.data,x.decision,x.ai_analysis_id,x.created_at",
          },
          orders: {
            from: "orders x",
            where: "x.bot_id=$1 AND x.tenant_id=$2",
            time: "x.updated_at",
            fields:
              "x.id,x.signal_id,x.client_id,x.exchange_id,x.side,x.symbol,x.quantity,x.order_type,x.limit_price,x.state,x.strategy_version,x.run_id,x.created_at,x.updated_at",
          },
          fills: {
            from: "executions x JOIN orders o ON o.id=x.order_id AND o.tenant_id=x.tenant_id",
            where: "o.bot_id=$1 AND x.tenant_id=$2",
            time: "x.executed_at",
            fields:
              "x.id,x.order_id,o.signal_id,o.side,o.symbol,o.run_id,x.quantity,x.price,x.fee,x.fee_currency,x.fee_amount,x.realized_net,x.executed_at",
          },
          orderEvents: {
            from: "order_events x JOIN orders o ON o.id=x.order_id AND o.tenant_id=x.tenant_id",
            where: "o.bot_id=$1 AND x.tenant_id=$2",
            time: "x.created_at",
            fields: "x.id,x.order_id,x.state,x.event_key,x.data,x.created_at",
          },
          aiStrategy: {
            from: "ai_strategy_decisions x",
            where: "x.bot_id=$1 AND x.tenant_id=$2",
            time: "x.created_at",
            fields:
              "x.id,x.candle_time,x.provider,x.model,x.prompt_version,x.input,x.result,x.status,x.error_code,x.created_at",
          },
          aiAnalyses: {
            from: "ai_analyses x",
            where: "x.bot_id=$1 AND x.tenant_id=$2",
            time: "x.created_at",
            fields:
              "x.id,x.candle_time,x.mode,x.provider,x.model,x.result,x.status,x.error_code,x.comparison,x.created_at,x.expires_at",
          },
          workerEvents: {
            from: "bot_diagnostic_events x",
            where: "x.bot_id=$1 AND x.tenant_id=$2",
            time: "x.created_at",
            fields: "x.id,x.snapshot,x.created_at",
          },
          runs: {
            from: "bot_runs x",
            where: "x.bot_id=$1 AND x.tenant_id=$2",
            time: "COALESCE(x.stopped_at,x.started_at)",
            fields: "x.id,x.started_at,x.stopped_at,x.stop_reason,x.origin",
          },
          activity: {
            from: "audit_logs x",
            where:
              "x.tenant_id=$2 AND (x.data->>'botId'=$1::text OR x.data->>'id'=$1::text)",
            time: "x.created_at",
            fields:
              "x.id,x.action,x.created_at,jsonb_build_object('reason',x.data->'reason','exchangeCode',x.data->'exchangeCode','status',x.data->'status','strategyVersion',x.data->'strategyVersion') AS data",
          },
          closedTrades: {
            from: "trade_cycles x",
            where: "x.bot_id=$1 AND x.tenant_id=$2",
            time: "x.closed_at",
            fields:
              "x.id,x.strategy_version,x.net_pnl,x.closed_at,x.closing_execution_id",
          },
        };
        const history: Record<string, any> = {},
          counts: Record<string, number> = {};
        for (const [name, s] of Object.entries(specs)) {
          const total = Number(
            (
              await db.query(
                `SELECT count(*) AS n FROM ${s.from} WHERE ${s.where} AND ${s.time}>=$3`,
                [id, tid, since],
              )
            ).rows[0].n,
          );
          const rows = (
            await db.query(
              `SELECT ${s.fields} FROM ${s.from} WHERE ${s.where} AND ${s.time}>=$3 ORDER BY ${s.time} DESC,x.id DESC LIMIT $4`,
              [id, tid, since, MAX],
            )
          ).rows;
          history[name] = {
            total,
            included: rows.length,
            truncated: total > rows.length,
            records: rows,
          };
          counts[name] = total;
        }
        const findings = summarizeDiagnostics(
          bot,
          current,
          history.signals.records,
          counts,
        );
        if (!executionEnabled)
          findings.unshift(
            "Testnet execution is disabled in Admin Settings; no new orders can be submitted.",
          );
        if (globalStop)
          findings.unshift("The platform global execution stop is active.");
        return redactDiagnostics({
          schemaVersion: 1,
          generatedAt,
          window: { since, hours, timestamps: "UTC ISO 8601" },
          bot,
          controls: { executionEnabled, globalStop },
          current,
          position,
          inventory,
          customStrategy,
          summary: { findings, counts },
          history,
          coverage: {
            workerEvents:
              "Collected from deployment of migration 011; state changes and 10-minute heartbeats retained for up to 14 days / 10,000 records per bot",
            history:
              "Latest 500 records per category within the selected period; inspect total and truncated before assuming completeness",
            note: "Current snapshots and positions are current/lifetime state, not reconstructed at the window start. Orders are selected by last update, fills by execution time. Older decisions may lack indicator diagnostics. No exchange requests are made by this export.",
          },
        });
      });
    },
  );
}
