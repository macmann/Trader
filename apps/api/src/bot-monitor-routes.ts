import { workerHealth } from "../../../packages/core/src/worker-health.ts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tenant } from "./db.ts";
import { testnetExecutionEnabled } from "./installation.ts";
import { terminalStates } from "./portfolio.ts";
import { botActionEnabled } from "../../../packages/core/src/bot-actions.ts";
const kinds = z.enum([
  "orders",
  "fills",
  "cycles",
  "signals",
  "activity",
  "events",
  "ai",
  "runs",
]);
const querySchema = z.object({
  kind: kinds.default("fills"),
  runId: z.uuid().optional(),
  cursor: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export function registerBotMonitorRoutes(app: FastifyInstance) {
  app.get("/api/bots/:id/monitor", async (req, reply) => {
    const id = z.uuid().parse((req.params as { id: string }).id),
      tid = req.identity!.tenantId;
    return tenant(tid, async (db) => {
      const bot = (
        await db.query(
          "SELECT b.id,b.name,b.status,b.symbol,b.timeframe,b.market_type,b.leverage,b.strategy_version,b.config,b.custom_strategy_id,b.ai_strategy_config,b.advanced_config,b.ai_mode,b.last_candle,b.created_at,c.id AS connection_id,c.name AS connection_name,c.provider,c.environment,c.status AS connection_status,c.last_verified_at,CASE WHEN b.market_type='LINEAR' THEN b.futures_reconciled_at ELSE c.reconciled_at END AS reconciled_at,c.ledger_version FROM bots b JOIN exchange_connections c ON c.id=b.connection_id AND c.tenant_id=b.tenant_id WHERE b.id=$1 AND b.tenant_id=$2",
          [id, tid],
        )
      ).rows[0];
      if (!bot) return reply.code(404).send({ error: "NOT_FOUND" });
      const monitor =
        (
          await db.query(
            "SELECT checked_at,last_success_at,snapshot,price,price_at,error_snapshot,error_at FROM bot_monitoring WHERE bot_id=$1 AND tenant_id=$2",
            [id, tid],
          )
        ).rows[0] ?? null;
      const position =
        (
          await db.query(
            "SELECT * FROM positions WHERE bot_id=$1 AND tenant_id=$2",
            [id, tid],
          )
        ).rows[0] ?? null;
      const inventory =
        (
          await db.query(
            "SELECT i.*, (SELECT COALESCE(sum(p.quantity),0) FROM bots b LEFT JOIN positions p ON p.bot_id=b.id AND p.tenant_id=b.tenant_id WHERE b.connection_id=i.connection_id AND b.tenant_id=i.tenant_id AND b.symbol=$3) AS managed_quantity FROM connection_inventory i WHERE i.tenant_id=$1 AND i.connection_id=$2 AND i.asset=$4",
            [
              tid,
              bot.connection_id,
              bot.symbol,
              bot.symbol.replace(/USDT$/, ""),
            ],
          )
        ).rows[0] ?? null;
      const pending = (
        await db.query(
          "SELECT id,client_id,exchange_id,side,symbol,quantity,state,order_type,limit_price,requested_notional,created_at,updated_at,run_id,recovery_requested_at FROM orders WHERE tenant_id=$1 AND bot_id=$2 AND NOT(state=ANY($3::text[])) ORDER BY created_at DESC,id",
          [tid, id, terminalStates],
        )
      ).rows;
      const summary = (
        await db.query(
          "SELECT count(*)::integer AS fills,count(DISTINCT o.id)::integer AS filled_orders,COALESCE(sum(e.fee),0) AS fees,COALESCE(sum(e.realized_gross-e.fee),0) AS ledger_net_cash_pnl FROM executions e JOIN orders o ON o.id=e.order_id AND o.tenant_id=e.tenant_id WHERE o.bot_id=$1 AND o.tenant_id=$2",
          [id, tid],
        )
      ).rows[0];
      const cycles = (
        await db.query(
          "SELECT count(*)::integer AS closed_cycles,count(*) FILTER(WHERE net_pnl>0)::integer AS wins,count(*) FILTER(WHERE net_pnl<0)::integer AS losses,COALESCE(sum(net_pnl),0) AS closed_net_pnl FROM trade_cycles WHERE bot_id=$1 AND tenant_id=$2",
          [id, tid],
        )
      ).rows[0];
      const lastSignal =
        (
          await db.query(
            "SELECT id,data,decision,strategy_version,candle_time,created_at FROM signals WHERE bot_id=$1 AND tenant_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
            [id, tid],
          )
        ).rows[0] ?? null;
      const run =
        (
          await db.query(
            "SELECT id,started_at,stopped_at,origin FROM bot_runs WHERE bot_id=$1 AND tenant_id=$2 AND stopped_at IS NULL",
            [id, tid],
          )
        ).rows[0] ?? null;
      const latestFailure =
        (
          await db.query(
            "SELECT action,data->>'reason' AS reason,created_at FROM audit_logs WHERE tenant_id=$1 AND action='RECONCILIATION_FAILED' AND data->>'botId'=$2 ORDER BY id DESC LIMIT 1",
            [tid, id],
          )
        ).rows[0] ?? null;
      const executionEnabled = await testnetExecutionEnabled(db),
        globalStop = (
          await db.query(
            "SELECT execution_stopped FROM platform_controls WHERE id=true",
          )
        ).rows[0].execution_stopped;
      const now = Date.now(),
        health = workerHealth(monitor, now),
        fresh = health.recent;
      const latestRecovery =
        (
          await db.query(
            "SELECT action,data,created_at FROM audit_logs WHERE tenant_id=$1 AND data->>'botId'=$2 AND action IN ('MISSING_ORDER_RECOVERY_REQUESTED','MISSING_ORDER_RECOVERY_COMPLETED','MISSING_ORDER_RECOVERY_REFUSED') ORDER BY id DESC LIMIT 1",
            [tid, id],
          )
        ).rows[0] ?? null;
      const priceFresh =
        !!monitor?.price_at &&
        now >= new Date(monitor.price_at).getTime() &&
        now - new Date(monitor.price_at).getTime() < 45000;
      const quantity = Number(position?.quantity ?? 0),
        cost = Number(position?.cost ?? 0),
        unrealized =
          quantity === 0
            ? 0
            : priceFresh
              ? (quantity * Number(monitor.price) - cost) *
                (bot.market_type === "LINEAR" &&
                position?.position_direction === "SHORT"
                  ? -1
                  : 1)
              : null;
      const realized =
        Number(position?.realized_pnl ?? 0) +
        Number(position?.funding_total ?? 0) -
        Number(position?.fees ?? 0);
      const blockers = [
        ...(!executionEnabled ? ["EXECUTION_DISABLED"] : []),
        ...(globalStop ? ["GLOBAL_EXECUTION_STOP"] : []),
        ...(bot.connection_status !== "CONNECTED"
          ? ["EXCHANGE_NOT_CONNECTED"]
          : []),
        ...(health.stale ? ["WORKER_STATUS_STALE_OR_UNKNOWN"] : []),
        ...(bot.status === "RISK_LOCKED" ? ["RISK_LOCKED"] : []),
      ];
      return {
        serverTime: new Date(now).toISOString(),
        bot,
        monitoring: monitor,
        workerFresh: fresh,
        workerWaitingForRetry: health.waiting,
        latestRecovery,
        recoveryAvailable:
          bot.provider === "OKX" &&
          bot.environment === "TESTNET" &&
          bot.market_type === "LINEAR" &&
          bot.status !== "ARCHIVED" &&
          ["OWNER", "ADMIN"].includes(req.identity!.role),
        priceFresh,
        position,
        inventory,
        openOrders: pending,
        summary: {
          ...summary,
          ...cycles,
          realizedNetPnl: realized,
          unrealizedPnl: unrealized,
          equity:
            unrealized === null
              ? null
              : Number(bot.config.capital) + realized + unrealized,
          averageEntry: quantity > 0 ? cost / quantity : null,
        },
        lastSignal,
        activeRun: run,
        latestFailure,
        executionEnabled,
        globalStop,
        blockers,
        actions: Object.fromEntries(
          ["start", "pause", "stop"].map((action) => [
            action,
            !(
              action === "start" &&
              pending.some((o: any) => o.recovery_requested_at)
            ) &&
              botActionEnabled(bot.status, action) &&
              req.identity!.role !== "VIEWER",
          ]),
        ),
      };
    });
  });
  app.get("/api/bots/:id/history", async (req, reply) => {
    const id = z.uuid().parse((req.params as { id: string }).id),
      tid = req.identity!.tenantId,
      q = querySchema.parse(req.query);
    return tenant(tid, async (db) => {
      if (
        !(
          await db.query("SELECT 1 FROM bots WHERE id=$1 AND tenant_id=$2", [
            id,
            tid,
          ])
        ).rowCount
      )
        return reply.code(404).send({ error: "NOT_FOUND" });
      let cursor: { time: string; id: string } | undefined;
      if (q.cursor) {
        try {
          const v = z
            .object({
              time: z
                .string()
                .max(64)
                .refine((v) => Number.isFinite(Date.parse(v))),
              id: ["activity", "events"].includes(q.kind)
                ? z
                    .string()
                    .regex(/^\d{1,19}$/)
                    .refine((v) => BigInt(v) <= 9223372036854775807n)
                : q.kind === "fills"
                  ? z.string().min(1).max(128)
                  : z.uuid(),
              bot: z.literal(id),
              kind: z.literal(q.kind),
              run: z.string(),
            })
            .parse(JSON.parse(Buffer.from(q.cursor, "base64url").toString()));
          if (v.run !== (q.runId ?? "")) throw Error();
          cursor = v;
        } catch {
          return reply.code(400).send({ error: "INVALID_CURSOR" });
        }
      }
      const specs: Record<
        z.infer<typeof kinds>,
        {
          from: string;
          columns: string;
          time: string;
          id: string;
          run: string;
          scope: string;
        }
      > = {
        orders: {
          from: "orders o",
          columns:
            "o.id,o.client_id,o.exchange_id,o.side,o.quantity,o.state,o.symbol,o.order_type,o.limit_price,o.created_at,o.updated_at,o.run_id,o.market_type,o.purpose,o.position_direction,o.leverage",
          time: "o.created_at",
          id: "o.id",
          run: "o.run_id",
          scope: "o.bot_id=$2 AND o.tenant_id=$1",
        },
        fills: {
          from: "executions e JOIN orders o ON o.id=e.order_id AND o.tenant_id=e.tenant_id",
          columns:
            "e.id,e.order_id,e.quantity,e.price,e.fee,e.fee_currency,e.fee_amount,e.realized_gross,e.realized_net,e.executed_at,o.side,o.symbol,o.run_id,o.strategy_version,o.market_type,o.purpose,o.position_direction,o.leverage",
          time: "e.executed_at",
          id: "e.id",
          run: "o.run_id",
          scope: "o.bot_id=$2 AND e.tenant_id=$1",
        },
        cycles: {
          from: "trade_cycles c JOIN executions e ON e.id=c.closing_execution_id AND e.tenant_id=c.tenant_id JOIN orders o ON o.id=e.order_id AND o.tenant_id=e.tenant_id",
          columns:
            "c.id,c.strategy_version,c.net_pnl,c.closed_at,c.closing_execution_id,o.run_id",
          time: "c.closed_at",
          id: "c.id",
          run: "o.run_id",
          scope: "c.bot_id=$2 AND c.tenant_id=$1",
        },
        signals: {
          from: "signals s",
          columns:
            "s.id,s.data,s.decision,s.strategy_version,s.candle_time,s.created_at,s.run_id",
          time: "s.created_at",
          id: "s.id",
          run: "s.run_id",
          scope: "s.bot_id=$2 AND s.tenant_id=$1",
        },
        activity: {
          from: "audit_logs a",
          columns:
            "a.id,a.action,a.created_at,a.data->>'reason' AS reason,a.data->>'exchangeCode' AS exchange_code",
          time: "a.created_at",
          id: "a.id",
          run: "NULL::uuid",
          scope:
            "a.tenant_id=$1 AND (a.data->>'botId'=$2::text OR a.data->>'id'=$2::text)",
        },
        events: {
          from: "order_events e JOIN orders o ON o.id=e.order_id AND o.tenant_id=e.tenant_id",
          columns: "e.id,e.order_id,e.state,e.created_at,e.event_key,o.run_id",
          time: "e.created_at",
          id: "e.id",
          run: "o.run_id",
          scope: "o.bot_id=$2 AND e.tenant_id=$1",
        },
        ai: {
          from: "(SELECT id,tenant_id,bot_id,mode,status,result,error_code,created_at,provider,model,NULL::jsonb AS indicators FROM ai_analyses UNION ALL SELECT id,tenant_id,bot_id,'STRATEGY'::text AS mode,status,result,error_code,created_at,provider,model,input->'indicators' AS indicators FROM ai_strategy_decisions) a",
          columns:
            "a.id,a.mode,a.status,a.result,a.error_code,a.created_at,a.provider,a.model,a.indicators",
          time: "a.created_at",
          id: "a.id",
          run: "NULL::uuid",
          scope: "a.bot_id=$2 AND a.tenant_id=$1",
        },
        runs: {
          from: "bot_runs r",
          columns: "r.id,r.started_at,r.stopped_at,r.stop_reason,r.origin",
          time: "r.started_at",
          id: "r.id",
          run: "r.id",
          scope: "r.bot_id=$2 AND r.tenant_id=$1",
        },
      };
      if (q.runId && ["activity", "ai"].includes(q.kind))
        return reply.code(400).send({ error: "RUN_FILTER_UNAVAILABLE" });
      const s = specs[q.kind];
      const idType = ["activity", "events"].includes(q.kind)
        ? "bigint"
        : q.kind === "fills"
          ? "text"
          : "uuid";
      const rows = (
        await db.query(
          `SELECT ${s.columns},${s.time}::text AS cursor_time FROM ${s.from} WHERE ${s.scope} AND ($3::uuid IS NULL OR ${s.run}=$3) AND ($4::timestamptz IS NULL OR (${s.time},${s.id})<($4::timestamptz,$5::${idType})) ORDER BY ${s.time} DESC,${s.id} DESC LIMIT $6`,
          [
            tid,
            id,
            q.runId ?? null,
            cursor?.time ?? null,
            cursor?.id ?? null,
            q.limit + 1,
          ],
        )
      ).rows;
      const more = rows.length > q.limit,
        items = rows.slice(0, q.limit),
        last = items.at(-1);
      const nextCursor = more
        ? Buffer.from(
            JSON.stringify({
              time: last.cursor_time,
              id: String(last.id),
              bot: id,
              kind: q.kind,
              run: q.runId ?? "",
            }),
          ).toString("base64url")
        : null;
      return {
        items: items.map(({ cursor_time, ...item }) => item),
        nextCursor,
      };
    });
  });
}
