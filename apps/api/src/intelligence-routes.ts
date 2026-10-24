import { runtimeProvider, runtimeConfiguration } from "./installation.ts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tenant, audit } from "./db.ts";
import {
  aiMode,
  buildMarketInput,
} from "../../../packages/ai-core/src/index.ts";
import { configuredProvider } from "../../../packages/ai-providers/src/index.ts";
import { BybitAdapter } from "../../../packages/core/src/index.ts";
import { analyzeBot, recentNews } from "../../worker/src/intelligence.ts";
export function registerIntelligenceRoutes(app: FastifyInstance) {
  app.get("/api/ai/status", async () => {
    const env = await runtimeConfiguration();
    return {
      provider: env.AI_PROVIDER ?? "disabled",
      model: env.AI_MODEL ?? null,
      ready: configuredProvider(env) !== null,
      newsEnabled: env.NEWS_ENABLED === "true",
      executionEnabled: process.env.TRADING_EXECUTION_ENABLED === "true",
      liveEnabled: false,
    };
  });
  app.get("/api/ai/analyses", async (req) => {
    const { botId } = z.object({ botId: z.uuid().optional() }).parse(req.query);
    return tenant(
      req.identity!.tenantId,
      async (db) =>
        (
          await db.query(
            "SELECT a.*,b.name AS bot_name FROM ai_analyses a JOIN bots b ON b.id=a.bot_id AND b.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND ($2::uuid IS NULL OR a.bot_id=$2) ORDER BY a.created_at DESC LIMIT 100",
            [req.identity!.tenantId, botId ?? null],
          )
        ).rows,
    );
  });
  app.get("/api/ai/comparison", async (req) =>
    tenant(req.identity!.tenantId, async (db) => ({
      ...(
        await db.query(
          "SELECT count(*) FILTER(WHERE comparison->>'direction'='LONG')::integer AS candidate_signals,count(*) FILTER(WHERE (comparison->>'strategyAllowed')::boolean AND comparison->>'direction'='LONG')::integer AS strategy_approved,count(*) FILTER(WHERE (comparison->>'strategyPlusFilterAllowed')::boolean AND comparison->>'direction'='LONG')::integer AS filter_approved,count(*) FILTER(WHERE status='FAILED')::integer AS failed_analyses FROM ai_analyses WHERE tenant_id=$1",
          [req.identity!.tenantId],
        )
      ).rows[0],
      note: "Recorded decision snapshots, including changed news and manual requests. Not unique trades, backtest results, or evidence of profitability.",
    })),
  );
  app.get("/api/news", async (req) =>
    tenant(
      req.identity!.tenantId,
      async (db) =>
        (
          await db.query(
            "SELECT id,source,title,url,published_at,received_at,analysis,analysis_status,error_code FROM news_articles WHERE published_at>now()-interval '7 days' ORDER BY published_at DESC LIMIT 50",
          )
        ).rows,
    ),
  );
  app.patch("/api/bots/:id/ai", async (req, reply) => {
    const id = z.uuid().parse((req.params as { id: string }).id),
      { mode } = z.strictObject({ mode: aiMode }).parse(req.body),
      tid = req.identity!.tenantId;
    return tenant(tid, async (db) => {
      const bot = (
        await db.query(
          "SELECT status FROM bots WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
          [id, tid],
        )
      ).rows[0];
      if (!bot) return reply.code(404).send({ error: "NOT_FOUND" });
      if (["RUNNING", "STARTING", "STOPPING"].includes(bot.status))
        return reply
          .code(409)
          .send({ error: "STOP_BOT_BEFORE_CHANGING_AI_MODE" });
      await db.query(
        "UPDATE bots SET ai_mode=$1,last_candle=NULL,last_ai_news=NULL WHERE id=$2 AND tenant_id=$3",
        [mode, id, tid],
      );
      await audit(db, tid, "BOT_AI_MODE_CHANGED", { botId: id, mode });
      return { mode };
    });
  });
  app.post(
    "/api/bots/:id/analyze",
    { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const id = z.uuid().parse((req.params as { id: string }).id),
        tid = req.identity!.tenantId;
      if (!(await runtimeProvider()))
        return reply.code(503).send({ error: "AI_UNAVAILABLE" });
      return tenant(tid, async (db) => {
        const bot = (
          await db.query("SELECT * FROM bots WHERE id=$1 AND tenant_id=$2", [
            id,
            tid,
          ])
        ).rows[0];
        if (!bot) return reply.code(404).send({ error: "NOT_FOUND" });
        if (bot.ai_mode === "OFF")
          return reply
            .code(409)
            .send({ error: "ENABLE_ADVISORY_OR_FILTER_MODE" });
        const candles = await new BybitAdapter("TESTNET").getCandles(
          bot.symbol,
        );
        const snapshot = buildMarketInput(candles, [], Date.now(), bot.symbol);
        const input = buildMarketInput(
          candles,
          await recentNews(db, snapshot.candleTime + 900000),
          Date.now(),
          bot.symbol,
        );
        const result = await analyzeBot(
          db,
          tid,
          id,
          bot.ai_mode,
          input,
          "NONE",
          false,
        );
        await audit(db, tid, "AI_ANALYSIS_REQUESTED", {
          botId: id,
          analysisId: result.id,
        });
        return {
          id: result.id,
          status: result.outcome?.status,
          error: result.outcome?.error,
        };
      });
    },
  );
}
