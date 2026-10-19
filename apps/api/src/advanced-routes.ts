import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tenant, audit } from "./db.ts";
import { botConfig } from "../../../packages/core/src/index.ts";
import {
  symbols,
  strategies,
  symbolSchema,
  strategySchema,
  advancedConfig,
  portfolioLimits,
  planPreview,
  configurationVeto,
} from "../../../packages/trading/src/index.ts";
import {
  lockPortfolio,
  portfolioSnapshot,
  allocationReasons,
} from "./portfolio.ts";
export function registerAdvancedRoutes(app: FastifyInstance) {
  app.get("/api/trading/options", async () => ({
    symbols,
    strategies,
    marketTypes: ["SPOT"],
    timeframes: ["15m"],
    derivativesSupported: false,
    advancedExecutionSupported: true,
    executionEnabled: process.env.TRADING_EXECUTION_ENABLED === "true",
  }));
  app.get("/api/portfolio", async (req) =>
    tenant(req.identity!.tenantId, (db) =>
      portfolioSnapshot(db, req.identity!.tenantId),
    ),
  );
  app.patch("/api/portfolio/limits", async (req, reply) => {
    const limits = portfolioLimits.parse(req.body),
      tid = req.identity!.tenantId;
    return tenant(tid, async (db) => {
      await lockPortfolio(db, tid);
      const current = await portfolioSnapshot(db, tid);
      if (
        current.unknownPending ||
        current.allocated > limits.maxTotalAllocation ||
        current.exposure + current.reserved > limits.maxTotalAllocation ||
        Object.values(current.connections).some(
          (c) =>
            c.allocated > limits.maxConnectionAllocation ||
            c.exposure + c.pending > limits.maxConnectionAllocation,
        ) ||
        Object.values(current.symbols).some(
          (s) =>
            s.allocated > limits.maxSymbolAllocation ||
            s.exposure + s.pending > limits.maxSymbolAllocation,
        ) ||
        current.openPositions > limits.maxOpenPositions
      )
        return reply
          .code(409)
          .send({ error: "LIMITS_BELOW_EXISTING_ALLOCATIONS_OR_POSITIONS" });
      await db.query(
        "INSERT INTO portfolio_limits(tenant_id,config) VALUES($1,$2) ON CONFLICT(tenant_id) DO UPDATE SET config=EXCLUDED.config,updated_at=now()",
        [tid, JSON.stringify(limits)],
      );
      await audit(db, tid, "PORTFOLIO_LIMITS_CHANGED", limits);
      return { limits };
    });
  });
  app.patch("/api/bots/:id/config", async (req, reply) => {
    const id = z.uuid().parse((req.params as { id: string }).id),
      v = z
        .strictObject({
          name: z.string().min(1).max(80).optional(),
          symbol: symbolSchema.optional(),
          strategyVersion: strategySchema.optional(),
          config: botConfig.optional(),
          advancedConfig: advancedConfig.optional(),
        })
        .parse(req.body),
      tid = req.identity!.tenantId;
    return tenant(tid, async (db) => {
      await lockPortfolio(db, tid);
      const bot = (
        await db.query(
          "SELECT * FROM bots WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
          [id, tid],
        )
      ).rows[0];
      if (!bot) return reply.code(404).send({ error: "NOT_FOUND" });
      if (!["STOPPED", "PAUSED", "RISK_LOCKED"].includes(bot.status))
        return reply.code(409).send({ error: "STOP_BOT_BEFORE_CONFIGURING" });
      const snapshot = await portfolioSnapshot(db, tid),
        existing = snapshot.bots.find((b) => b.id === id)!;
      if (
        Number(existing.quantity) > 0 ||
        snapshot.unknownPending ||
        (
          await db.query(
            "SELECT 1 FROM orders WHERE bot_id=$1 AND tenant_id=$2 AND state NOT IN ('Filled','Cancelled','Rejected','Deactivated','FILLED','CANCELLED','REJECTED') LIMIT 1",
            [id, tid],
          )
        ).rowCount
      )
        return reply
          .code(409)
          .send({ error: "OPEN_EXPOSURE_PREVENTS_CONFIGURATION_CHANGE" });
      const config = v.config ?? botConfig.parse(bot.config),
        advanced =
          v.advancedConfig ?? advancedConfig.parse(bot.advanced_config),
        symbol = v.symbol ?? bot.symbol,
        strategy = v.strategyVersion ?? bot.strategy_version;
      const invalid = configurationVeto(strategy, advanced);
      if (invalid) return reply.code(400).send({ error: invalid });
      snapshot.allocated -= Number(bot.config.capital);
      snapshot.connections[bot.connection_id].allocated -= Number(
        bot.config.capital,
      );
      snapshot.symbols[bot.symbol].allocated -= Number(bot.config.capital);
      const reasons = allocationReasons(
        snapshot,
        config.capital,
        bot.connection_id,
        symbol,
      );
      if (reasons.length)
        return reply
          .code(409)
          .send({ error: "PORTFOLIO_ALLOCATION_REJECTED", reasons });
      await db.query(
        "UPDATE bots SET name=$1,symbol=$2,strategy_version=$3,config=$4,advanced_config=$5,last_candle=NULL,last_ai_news=NULL WHERE id=$6 AND tenant_id=$7",
        [
          v.name ?? bot.name,
          symbol,
          strategy,
          JSON.stringify(config),
          JSON.stringify(advanced),
          id,
          tid,
        ],
      );
      await db.query(
        "UPDATE positions SET peak_equity=GREATEST(0,$1::numeric+realized_pnl-fees) WHERE bot_id=$2 AND tenant_id=$3",
        [config.capital, id, tid],
      );
      await audit(db, tid, "BOT_CONFIG_CHANGED", {
        botId: id,
        symbol,
        strategyVersion: strategy,
      });
      return { ok: true };
    });
  });
  app.post("/api/bots/:id/preview", async (req, reply) => {
    const id = z.uuid().parse((req.params as { id: string }).id),
      v = z
        .strictObject({
          price: z.number().positive().max(10000000),
          availableBalance: z.number().nonnegative().max(100000000),
          quantityStep: z
            .string()
            .regex(/^\d{1,12}(?:\.\d{1,12})?$/)
            .refine((s) => Number(s) > 0)
            .default("0.000001"),
          priceTick: z
            .string()
            .regex(/^\d{1,12}(?:\.\d{1,12})?$/)
            .refine((s) => Number(s) > 0)
            .default("0.01"),
          minNotional: z.number().nonnegative().default(5),
          maxQuantity: z.number().positive().optional(),
          candles: z
            .array(
              z.object({
                time: z.number().int().nonnegative(),
                open: z.number().positive(),
                high: z.number().positive(),
                low: z.number().positive(),
                close: z.number().positive(),
                volume: z.number().nonnegative(),
              }),
            )
            .max(100)
            .default([]),
        })
        .parse(req.body),
      tid = req.identity!.tenantId;
    return tenant(tid, async (db) => {
      const b = (
        await db.query(
          "SELECT b.*,p.quantity,p.cost,p.high_watermark,p.last_entry_price,p.last_entry_at,p.entry_count,p.grid_levels_filled,p.last_exit_price FROM bots b JOIN positions p ON p.bot_id=b.id AND p.tenant_id=b.tenant_id WHERE b.id=$1 AND b.tenant_id=$2",
          [id, tid],
        )
      ).rows[0];
      if (!b) return reply.code(404).send({ error: "NOT_FOUND" });
      const snapshot = await portfolioSnapshot(db, tid),
        config = botConfig.parse(b.config),
        advanced = advancedConfig.parse(b.advanced_config),
        c = snapshot.connections[b.connection_id],
        s = snapshot.symbols[b.symbol];
      return {
        symbol: b.symbol,
        ...planPreview({
          strategy: b.strategy_version,
          advanced,
          ...config,
          price: v.price,
          available: Math.max(0, v.availableBalance - (c?.pending ?? 0)),
          position: {
            quantity: Number(b.quantity),
            cost: Number(b.cost),
            highWatermark: Number(b.high_watermark),
            lastEntryPrice: Number(b.last_entry_price),
            lastEntryAt: b.last_entry_at?.getTime() ?? 0,
            entryCount: b.entry_count,
            gridLevelsFilled: b.grid_levels_filled,
            lastExitPrice: Number(b.last_exit_price),
          },
          candles: v.candles,
          limits: snapshot.limits,
          exposure: {
            total: snapshot.exposure + snapshot.reserved,
            connection: (c?.exposure ?? 0) + (c?.pending ?? 0),
            symbol: (s?.exposure ?? 0) + (s?.pending ?? 0),
            pending: snapshot.reserved,
            openPositions: snapshot.openPositions,
            unknownPending: snapshot.unknownPending,
          },
          quantityStep: v.quantityStep,
          priceTick: v.priceTick,
          minNotional: v.minNotional,
          maxQuantity: v.maxQuantity,
        }),
      };
    });
  });
}
