import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  randomUUID,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { pool, tenant, audit } from "./db.ts";
import { userContext, entitlements, consume, plans } from "./platform.ts";
import { lockPortfolio } from "./portfolio.ts";
import {
  researchConfig,
  candleSeries,
  datasetHash,
  simulate,
  walkForward,
} from "../../../packages/research/src/index.ts";
import {
  advancedConfig,
  configurationVeto,
} from "../../../packages/trading/src/index.ts";
const uuid = z.uuid();
const recent = (req: any) =>
  Date.now() - req.identity.reauthenticatedAt.getTime() < 300000;
export const billingSchema = z.strictObject({
  id: z.string().min(1).max(100),
  tenantId: uuid,
  plan: z.enum(["FREE", "BASIC", "PRO"]),
  status: z.enum(["ACTIVE", "PAST_DUE", "CANCELLED"]),
  periodEnd: z.iso.datetime(),
  occurredAt: z.iso.datetime(),
});
export function billingSignature(
  body: z.infer<typeof billingSchema>,
  timestamp: string,
  key: string,
) {
  return createHmac("sha256", key)
    .update(timestamp + "." + JSON.stringify(billingSchema.parse(body)))
    .digest("hex");
}
export function registerPlatformRoutes(app: FastifyInstance) {
  app.get("/api/workspaces", async (req) =>
    userContext(
      req.identity!.userId,
      async (db) =>
        (
          await db.query(
            "SELECT w.id,w.name,w.kind,m.role FROM workspaces w JOIN workspace_members m ON m.tenant_id=w.id WHERE m.user_id=$1 ORDER BY w.name",
            [req.identity!.userId],
          )
        ).rows,
    ),
  );
  app.post("/api/auth/workspace", async (req, reply) => {
    const { tenantId } = z.strictObject({ tenantId: uuid }).parse(req.body),
      i = req.identity!;
    return userContext(i.userId, async (db) => {
      if (
        !(
          await db.query(
            "SELECT 1 FROM workspace_members WHERE tenant_id=$1 AND user_id=$2",
            [tenantId, i.userId],
          )
        ).rowCount
      )
        return reply.code(403).send({ error: "WORKSPACE_FORBIDDEN" });
      await db.query(
        "UPDATE sessions SET active_tenant_id=$1 WHERE token_hash=$2 AND user_id=$3",
        [
          tenantId,
          createHash("sha256").update(i.token).digest("hex"),
          i.userId,
        ],
      );
      return { ok: true };
    });
  });
  app.post("/api/workspaces", async (req, reply) => {
    if (!recent(req))
      return reply.code(403).send({ error: "REAUTHENTICATION_REQUIRED" });
    const v = z
        .strictObject({ name: z.string().trim().min(1).max(80) })
        .parse(req.body),
      id = randomUUID(),
      i = req.identity!;
    return tenant(i.tenantId, async (db) => {
      await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [i.userId]);
      if (
        Number(
          (
            await db.query(
              "SELECT count(*) AS n FROM workspaces WHERE owner_id=$1 AND kind='ORGANIZATION'",
              [i.userId],
            )
          ).rows[0].n,
        ) >= 5
      )
        return reply.code(409).send({ error: "ORGANIZATION_LIMIT" });
      await db.query(
        "INSERT INTO workspaces(id,owner_id,name,kind) VALUES($1,$2,$3,'ORGANIZATION')",
        [id, i.userId, v.name],
      );
      return reply.code(201).send({ id });
    });
  });
  app.get("/api/workspace/members", async (req) =>
    tenant(
      req.identity!.tenantId,
      async (db) =>
        (
          await db.query(
            "SELECT m.user_id,m.role,u.email FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY m.created_at",
            [req.identity!.tenantId],
          )
        ).rows,
    ),
  );
  app.put("/api/workspace/members", async (req, reply) => {
    if (!recent(req))
      return reply.code(403).send({ error: "REAUTHENTICATION_REQUIRED" });
    const v = z
        .strictObject({
          email: z.email().transform((s) => s.toLowerCase()),
          role: z.enum(["ADMIN", "TRADER", "VIEWER"]),
        })
        .parse(req.body),
      i = req.identity!;
    return tenant(i.tenantId, async (db) => {
      await lockPortfolio(db, i.tenantId);
      const workspace = (
        await db.query("SELECT kind FROM workspaces WHERE id=$1", [i.tenantId])
      ).rows[0];
      if (workspace.kind !== "ORGANIZATION")
        return reply.code(409).send({ error: "ORGANIZATION_REQUIRED" });
      const target = (
        await db.query(
          "SELECT id FROM users WHERE email=$1 AND verified=true",
          [v.email],
        )
      ).rows[0];
      if (!target)
        return reply.code(404).send({ error: "VERIFIED_ACCOUNT_REQUIRED" });
      const member = (
        await db.query(
          "SELECT role FROM workspace_members WHERE tenant_id=$1 AND user_id=$2",
          [i.tenantId, target.id],
        )
      ).rows[0];
      if (
        member?.role === "OWNER" ||
        (i.role !== "OWNER" && (v.role === "ADMIN" || member?.role === "ADMIN"))
      )
        return reply.code(403).send({ error: "OWNER_REQUIRED" });
      if (
        !member &&
        Number(
          (
            await db.query(
              "SELECT count(*) AS n FROM workspace_members WHERE tenant_id=$1",
              [i.tenantId],
            )
          ).rows[0].n,
        ) >= 50
      )
        return reply.code(409).send({ error: "MEMBER_LIMIT" });
      await db.query(
        "INSERT INTO workspace_members(tenant_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(tenant_id,user_id) DO UPDATE SET role=EXCLUDED.role",
        [i.tenantId, target.id, v.role],
      );
      await audit(db, i.tenantId, "MEMBER_ROLE_CHANGED", {
        userId: target.id,
        role: v.role,
        actor: i.userId,
      });
      return { ok: true };
    });
  });
  app.delete("/api/workspace/members/:id", async (req, reply) => {
    if (!recent(req))
      return reply.code(403).send({ error: "REAUTHENTICATION_REQUIRED" });
    const id = uuid.parse((req.params as any).id),
      i = req.identity!;
    return tenant(i.tenantId, async (db) => {
      await lockPortfolio(db, i.tenantId);
      const m = (
        await db.query(
          "SELECT role FROM workspace_members WHERE tenant_id=$1 AND user_id=$2",
          [i.tenantId, id],
        )
      ).rows[0];
      if (!m) return reply.code(404).send({ error: "NOT_FOUND" });
      if (m.role === "OWNER" || (m.role === "ADMIN" && i.role !== "OWNER"))
        return reply.code(403).send({ error: "OWNER_REQUIRED" });
      await db.query(
        "DELETE FROM workspace_members WHERE tenant_id=$1 AND user_id=$2",
        [i.tenantId, id],
      );
      await audit(db, i.tenantId, "MEMBER_REMOVED", {
        userId: id,
        actor: i.userId,
      });
      return { ok: true };
    });
  });
  app.get("/api/subscription", async (req) =>
    tenant(req.identity!.tenantId, async (db) => ({
      ...(await entitlements(db, req.identity!.tenantId)),
      plans,
      usage: (
        await db.query(
          "SELECT metric,sum(units)::integer AS units FROM usage_records WHERE tenant_id=$1 AND created_at>=date_trunc('month',now()) GROUP BY metric",
          [req.identity!.tenantId],
        )
      ).rows,
      paymentCollectionEnabled: false,
    })),
  );
  app.post("/api/billing/gateway", async (req, reply) => {
    const key = process.env.BILLING_WEBHOOK_SECRET,
      timestamp = String(req.headers["x-billing-timestamp"] ?? ""),
      sig = String(req.headers["x-billing-signature"] ?? ""),
      body = billingSchema.parse(req.body);
    if (!key) return reply.code(503).send({ error: "BILLING_NOT_CONFIGURED" });
    if (
      !/^\d{10}$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
      !/^[a-f0-9]{64}$/.test(sig) ||
      !timingSafeEqual(
        Buffer.from(sig, "hex"),
        Buffer.from(billingSignature(body, timestamp, key), "hex"),
      )
    )
      return reply.code(401).send({ error: "INVALID_BILLING_SIGNATURE" });
    if (new Date(body.occurredAt).getTime() > Date.now() + 300000)
      return reply.code(400).send({ error: "INVALID_EVENT_TIME" });
    return tenant(body.tenantId, async (db) => {
      await lockPortfolio(db, body.tenantId);
      const added = await db.query(
        "INSERT INTO billing_events(id,tenant_id,occurred_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id",
        [body.id, body.tenantId, body.occurredAt],
      );
      if (added.rowCount) {
        await db.query(
          "UPDATE subscriptions SET plan=$1,status=$2,period_end=$3,last_event_at=$4,updated_at=now() WHERE tenant_id=$5 AND (last_event_at IS NULL OR last_event_at<$4)",
          [
            body.plan,
            body.status,
            body.periodEnd,
            body.occurredAt,
            body.tenantId,
          ],
        );
        await audit(db, body.tenantId, "SUBSCRIPTION_EVENT", { id: body.id });
      }
      return { ok: true, duplicate: !added.rowCount };
    });
  });
  app.get("/api/research", async (req) =>
    tenant(
      req.identity!.tenantId,
      async (db) =>
        (
          await db.query(
            "SELECT id,kind,symbol,strategy_version,settings,dataset_hash,result,created_at FROM research_runs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50",
            [req.identity!.tenantId],
          )
        ).rows,
    ),
  );
  app.post("/api/research", { bodyLimit: 1500000 }, async (req, reply) => {
    const v = z
        .strictObject({
          configuration: researchConfig,
          candles: candleSeries,
          walkForward: z
            .strictObject({
              trainBars: z.number().int().min(60).max(2000),
              testBars: z.number().int().min(15).max(1000),
              candidates: z.array(advancedConfig).min(1).max(6),
            })
            .optional(),
        })
        .parse(req.body),
      tid = req.identity!.tenantId,
      id = randomUUID();
    if (
      v.walkForward &&
      (v.candles.length < v.walkForward.trainBars + v.walkForward.testBars ||
        v.walkForward.candidates.some((a) =>
          configurationVeto(v.configuration.strategyVersion, a),
        ))
    )
      return reply
        .code(400)
        .send({ error: "INVALID_WALK_FORWARD_CONFIGURATION" });
    return tenant(tid, async (db) => {
      await consume(db, tid, "backtests", id);
      const result = v.walkForward
        ? walkForward(
            v.configuration,
            v.candles,
            v.walkForward.candidates,
            v.walkForward.trainBars,
            v.walkForward.testBars,
          )
        : simulate(v.configuration, v.candles);
      await db.query(
        "INSERT INTO research_runs(id,tenant_id,kind,symbol,strategy_version,config,advanced_config,settings,dataset_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          tid,
          v.walkForward ? "WALK_FORWARD" : "BACKTEST",
          v.configuration.symbol,
          v.configuration.strategyVersion,
          JSON.stringify(v.configuration.config),
          JSON.stringify(v.configuration.advancedConfig),
          JSON.stringify(v.configuration.settings),
          datasetHash(v.candles),
          JSON.stringify(result),
        ],
      );
      return reply.code(201).send({ id, result });
    });
  });
  app.get("/api/paper", async (req) =>
    tenant(
      req.identity!.tenantId,
      async (db) =>
        (
          await db.query(
            "SELECT id,name,symbol,strategy_version,status,revision,result,feed_mode FROM paper_sessions WHERE tenant_id=$1 ORDER BY created_at DESC",
            [req.identity!.tenantId],
          )
        ).rows,
    ),
  );
  app.post("/api/paper", async (req, reply) => {
    const v = z
        .strictObject({
          name: z.string().min(1).max(80),
          feedMode: z.enum(["REPLAY", "MARKET"]).default("REPLAY"),
          configuration: researchConfig,
        })
        .parse(req.body),
      tid = req.identity!.tenantId,
      id = randomUUID();
    return tenant(tid, async (db) => {
      await lockPortfolio(db, tid);
      const e = await entitlements(db, tid);
      if (
        Number(
          (
            await db.query(
              "SELECT count(*) AS n FROM paper_sessions WHERE tenant_id=$1",
              [tid],
            )
          ).rows[0].n,
        ) >= e.limits.paper
      )
        return reply.code(409).send({ error: "PAPER_PLAN_LIMIT" });
      await db.query(
        "INSERT INTO paper_sessions(id,tenant_id,name,symbol,strategy_version,config,advanced_config,settings,result,feed_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          tid,
          v.name,
          v.configuration.symbol,
          v.configuration.strategyVersion,
          JSON.stringify(v.configuration.config),
          JSON.stringify(v.configuration.advancedConfig),
          JSON.stringify(v.configuration.settings),
          JSON.stringify(simulate(v.configuration, [], 0, false)),
          v.feedMode,
        ],
      );
      return reply.code(201).send({ id });
    });
  });
  app.post(
    "/api/paper/:id/advance",
    { bodyLimit: 1500000 },
    async (req, reply) => {
      const id = uuid.parse((req.params as any).id),
        v = z
          .strictObject({
            revision: z.number().int().nonnegative(),
            candles: candleSeries,
          })
          .parse(req.body),
        tid = req.identity!.tenantId;
      return tenant(tid, async (db) => {
        const p = (
          await db.query(
            "SELECT * FROM paper_sessions WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
            [tid, id],
          )
        ).rows[0];
        if (!p) return reply.code(404).send({ error: "NOT_FOUND" });
        if (
          p.status !== "RUNNING" ||
          p.revision !== v.revision ||
          p.feed_mode !== "REPLAY"
        )
          return reply
            .code(409)
            .send({ error: "PAPER_REVISION_OR_STATUS_CONFLICT" });
        const candles = candleSeries.parse([...p.candles, ...v.candles]);
        const result = simulate(
          {
            symbol: p.symbol,
            strategyVersion: p.strategy_version,
            config: p.config,
            advancedConfig: p.advanced_config,
            settings: p.settings,
          },
          candles,
          0,
          false,
        );
        await db.query(
          "UPDATE paper_sessions SET candles=$1,result=$2,revision=revision+1 WHERE tenant_id=$3 AND id=$4",
          [JSON.stringify(candles), JSON.stringify(result), tid, id],
        );
        return { revision: p.revision + 1, result };
      });
    },
  );
  app.post("/api/paper/:id/stop", async (req, reply) =>
    tenant(req.identity!.tenantId, async (db) => {
      const r = await db.query(
        "UPDATE paper_sessions SET status='STOPPED',revision=revision+1 WHERE tenant_id=$1 AND id=$2 RETURNING id",
        [req.identity!.tenantId, uuid.parse((req.params as any).id)],
      );
      return r.rowCount
        ? { ok: true }
        : reply.code(404).send({ error: "NOT_FOUND" });
    }),
  );
  app.delete("/api/paper/:id", async (req, reply) =>
    tenant(req.identity!.tenantId, async (db) => {
      const r = await db.query(
        "DELETE FROM paper_sessions WHERE tenant_id=$1 AND id=$2 RETURNING id",
        [req.identity!.tenantId, uuid.parse((req.params as any).id)],
      );
      return r.rowCount
        ? { ok: true }
        : reply.code(404).send({ error: "NOT_FOUND" });
    }),
  );
  app.get("/api/marketplace", async (req) =>
    tenant(
      req.identity!.tenantId,
      async (db) =>
        (
          await db.query(
            "SELECT s.id,s.name,s.description,s.tenant_id=$1 AS is_owner,v.id AS version_id,v.version,v.symbol,v.strategy_version,v.config,v.advanced_config,v.risk_classification,v.historical_results,v.created_at,ss.version_id IS NOT NULL AS subscribed,(SELECT e.result FROM marketplace_evidence e WHERE e.version_id=v.id AND e.environment='LIVE' ORDER BY e.created_at DESC LIMIT 1) AS verified_live_results,(SELECT e.result FROM marketplace_evidence e WHERE e.version_id=v.id AND e.environment='TESTNET' ORDER BY e.created_at DESC LIMIT 1) AS verified_testnet_results FROM strategy_listings s JOIN marketplace_versions v ON v.listing_id=s.id LEFT JOIN strategy_subscriptions ss ON ss.version_id=v.id AND ss.tenant_id=$1 WHERE s.status='PUBLISHED' ORDER BY v.created_at DESC LIMIT 100",
            [req.identity!.tenantId],
          )
        ).rows,
    ),
  );
  app.post("/api/marketplace/listings/:id/evidence", async (req, reply) => {
    const listingId = uuid.parse((req.params as any).id),
      { botId } = z.strictObject({ botId: uuid }).parse(req.body),
      tid = req.identity!.tenantId;
    return tenant(tid, async (db) => {
      await lockPortfolio(db, tid);
      const b = (
        await db.query(
          "SELECT b.*,c.environment,c.ledger_version,v.config AS source_config,v.advanced_config AS source_advanced,v.strategy_version AS source_strategy FROM bots b JOIN exchange_connections c ON c.id=b.connection_id AND c.tenant_id=b.tenant_id JOIN marketplace_versions v ON v.id=b.marketplace_version_id AND v.tenant_id=b.tenant_id JOIN strategy_listings s ON s.id=v.listing_id WHERE b.id=$1 AND b.tenant_id=$2 AND s.id=$3",
          [botId, tid, listingId],
        )
      ).rows[0];
      if (
        !b ||
        b.ledger_version !== 2 ||
        JSON.stringify(b.config) !== JSON.stringify(b.source_config) ||
        JSON.stringify(b.advanced_config) !==
          JSON.stringify(b.source_advanced) ||
        b.strategy_version !== b.source_strategy
      )
        return reply
          .code(409)
          .send({ error: "MATCHING_RECONCILED_MARKETPLACE_BOT_REQUIRED" });
      const cycles = (
        await db.query(
          "SELECT t.id,t.net_pnl,t.closed_at,t.closing_execution_id FROM trade_cycles t JOIN executions e ON e.id=t.closing_execution_id AND e.tenant_id=t.tenant_id JOIN orders o ON o.id=e.order_id AND o.tenant_id=e.tenant_id WHERE t.tenant_id=$1 AND t.bot_id=$2 AND o.state='Filled' AND t.strategy_version=$3 ORDER BY t.closed_at,t.id",
          [tid, botId, b.strategy_version],
        )
      ).rows;
      if (!cycles.length)
        return reply
          .code(409)
          .send({ error: "CLOSED_RECONCILED_TRADES_REQUIRED" });
      let equity = Number(b.source_config.capital),
        peak = equity,
        drawdown = 0;
      for (const c of cycles) {
        equity += Number(c.net_pnl);
        peak = Math.max(peak, equity);
        drawdown = Math.max(drawdown, ((peak - equity) / peak) * 100);
      }
      const result = {
        verification: "EXCHANGE_RECONCILED",
        environment: b.environment,
        simulationOnly: false,
        closedTrades: cycles.length,
        netPnl: equity - Number(b.source_config.capital),
        netReturnPct: (equity / Number(b.source_config.capital) - 1) * 100,
        closedTradeDrawdownPct: drawdown,
        from: cycles[0].closed_at,
        to: cycles.at(-1).closed_at,
        note: "Closed-trade results only; excludes open-position P&L and intratrade drawdown.",
      };
      const sourceHash = createHash("sha256")
        .update(JSON.stringify(cycles))
        .digest("hex");
      await db.query(
        "INSERT INTO marketplace_evidence(id,tenant_id,version_id,bot_id,environment,result,source_hash) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
        [
          randomUUID(),
          tid,
          b.marketplace_version_id,
          botId,
          b.environment,
          JSON.stringify(result),
          sourceHash,
        ],
      );
      await audit(db, tid, "STRATEGY_EVIDENCE_PUBLISHED", {
        versionId: b.marketplace_version_id,
        sourceHash,
      });
      return { result };
    });
  });
  app.post("/api/marketplace/listings", async (req, reply) => {
    const v = z
        .strictObject({
          name: z.string().trim().min(1).max(80),
          description: z.string().trim().min(1).max(1500),
          researchRunId: uuid,
          listingId: uuid.optional(),
        })
        .parse(req.body),
      tid = req.identity!.tenantId;
    return tenant(tid, async (db) => {
      await lockPortfolio(db, tid);
      const run = (
        await db.query(
          "SELECT * FROM research_runs WHERE id=$1 AND tenant_id=$2 AND kind='BACKTEST'",
          [v.researchRunId, tid],
        )
      ).rows[0];
      if (!run) return reply.code(404).send({ error: "OWN_BACKTEST_REQUIRED" });
      let listingId = v.listingId ?? randomUUID();
      if (v.listingId) {
        if (
          !(
            await db.query(
              "SELECT 1 FROM strategy_listings WHERE id=$1 AND tenant_id=$2 AND status='PUBLISHED'",
              [listingId, tid],
            )
          ).rowCount
        )
          return reply.code(404).send({ error: "NOT_FOUND" });
      } else {
        if (
          Number(
            (
              await db.query(
                "SELECT count(*) AS n FROM strategy_listings WHERE tenant_id=$1",
                [tid],
              )
            ).rows[0].n,
          ) >= 50
        )
          return reply.code(409).send({ error: "LISTING_LIMIT" });
        await db.query(
          "INSERT INTO strategy_listings(id,tenant_id,name,description) VALUES($1,$2,$3,$4)",
          [listingId, tid, v.name, v.description],
        );
      }
      const version = Number(
          (
            await db.query(
              "SELECT COALESCE(max(version),0)+1 AS n FROM marketplace_versions WHERE listing_id=$1",
              [listingId],
            )
          ).rows[0].n,
        ),
        id = randomUUID(),
        r = run.result;
      const historical = {
        datasetHash: run.dataset_hash,
        settings: run.settings,
        engineVersion: r.engineVersion,
        startingEquity: r.startingEquity,
        endingEquity: r.endingEquity,
        returnPct: r.returnPct,
        maxDrawdownPct: r.maxDrawdownPct,
        fees: r.fees,
        closedTrades: r.closedTrades,
        winRate: r.winRate,
        profitFactor: r.profitFactor,
        periodStart: r.equity?.[0]?.time ?? null,
        periodEnd: r.equity?.at(-1)?.time ?? null,
        simulationOnly: true,
        verifiedLive: false,
      };
      await db.query(
        "INSERT INTO marketplace_versions(id,tenant_id,listing_id,version,symbol,strategy_version,config,advanced_config,risk_classification,research_run_id,historical_results) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          id,
          tid,
          listingId,
          version,
          run.symbol,
          run.strategy_version,
          JSON.stringify(run.config),
          JSON.stringify(run.advanced_config),
          run.strategy_version === "dca-v1.0" ||
          run.strategy_version.startsWith("grid-")
            ? "VERY_HIGH"
            : "HIGH",
          run.id,
          JSON.stringify(historical),
        ],
      );
      await audit(db, tid, "STRATEGY_VERSION_PUBLISHED", {
        listingId,
        versionId: id,
        version,
      });
      return reply.code(201).send({ listingId, versionId: id, version });
    });
  });
  app.post("/api/marketplace/versions/:id/subscribe", async (req, reply) => {
    const id = uuid.parse((req.params as any).id),
      tid = req.identity!.tenantId;
    return tenant(tid, async (db) => {
      await lockPortfolio(db, tid);
      const version = (
        await db.query(
          "SELECT v.id FROM marketplace_versions v JOIN strategy_listings s ON s.id=v.listing_id WHERE v.id=$1 AND s.status='PUBLISHED'",
          [id],
        )
      ).rows[0];
      if (!version) return reply.code(404).send({ error: "NOT_FOUND" });
      const e = await entitlements(db, tid);
      if (
        Number(
          (
            await db.query(
              "SELECT count(*) AS n FROM strategy_subscriptions WHERE tenant_id=$1",
              [tid],
            )
          ).rows[0].n,
        ) >= e.limits.marketplace
      )
        return reply.code(409).send({ error: "SUBSCRIPTION_PLAN_LIMIT" });
      await db.query(
        "INSERT INTO strategy_subscriptions(tenant_id,version_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [tid, id],
      );
      await audit(db, tid, "STRATEGY_SUBSCRIBED", { versionId: id });
      return { ok: true };
    });
  });
  app.delete("/api/marketplace/subscriptions/:id", async (req) =>
    tenant(req.identity!.tenantId, async (db) => {
      await db.query(
        "DELETE FROM strategy_subscriptions WHERE tenant_id=$1 AND version_id=$2",
        [req.identity!.tenantId, uuid.parse((req.params as any).id)],
      );
      return { ok: true };
    }),
  );
  app.post("/api/marketplace/listings/:id/retire", async (req, reply) =>
    tenant(req.identity!.tenantId, async (db) => {
      const r = await db.query(
        "UPDATE strategy_listings SET status='RETIRED' WHERE id=$1 AND tenant_id=$2 RETURNING id",
        [uuid.parse((req.params as any).id), req.identity!.tenantId],
      );
      return r.rowCount
        ? { ok: true }
        : reply.code(404).send({ error: "NOT_FOUND" });
    }),
  );
  app.get("/api/notifications", async (req) =>
    tenant(
      req.identity!.tenantId,
      async (db) =>
        (
          await db.query(
            "SELECT id,title,read_at,created_at,telegram_state FROM notifications WHERE tenant_id=$1 ORDER BY id DESC LIMIT 100",
            [req.identity!.tenantId],
          )
        ).rows,
    ),
  );
  app.post("/api/notifications/:id/read", async (req) =>
    tenant(req.identity!.tenantId, async (db) => {
      await db.query(
        "UPDATE notifications SET read_at=now() WHERE tenant_id=$1 AND id=$2",
        [
          req.identity!.tenantId,
          z.coerce
            .number()
            .int()
            .positive()
            .parse((req.params as any).id),
        ],
      );
      return { ok: true };
    }),
  );
  app.get("/api/notifications/settings", async (req) =>
    tenant(req.identity!.tenantId, async (db) => ({
      telegramConfigured: !!process.env.TELEGRAM_BOT_TOKEN,
      ...(
        await db.query(
          "SELECT enabled,telegram_chat_id FROM notification_settings WHERE tenant_id=$1",
          [req.identity!.tenantId],
        )
      ).rows[0],
    })),
  );
  app.put("/api/notifications/settings", async (req, reply) => {
    if (!recent(req))
      return reply.code(403).send({ error: "REAUTHENTICATION_REQUIRED" });
    const v = z
      .strictObject({
        enabled: z.boolean(),
        chatId: z.string().regex(/^-?\d{1,20}$/),
      })
      .parse(req.body);
    return tenant(req.identity!.tenantId, async (db) => {
      await db.query(
        "INSERT INTO notification_settings(tenant_id,telegram_chat_id,enabled) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET telegram_chat_id=EXCLUDED.telegram_chat_id,enabled=EXCLUDED.enabled,updated_at=now()",
        [req.identity!.tenantId, v.chatId, v.enabled],
      );
      await audit(db, req.identity!.tenantId, "NOTIFICATION_SETTINGS_CHANGED");
      return { ok: true };
    });
  });
}
