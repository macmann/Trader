import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { tenant, audit } from "./db.ts";
import { runtimeConfiguration } from "./installation.ts";
import {
  rulesSchema,
  aiStrategyConfig,
  modelCatalog,
} from "../../../packages/trading/src/creator.ts";
export async function aiModels(db?: Pick<pg.Pool, "query">) {
  const config = await runtimeConfiguration(db);
  return {
    provider: config.AI_PROVIDER ?? "disabled",
    configured: !!config.AI_API_KEY && config.AI_PROVIDER !== "disabled",
    models: [
      ...new Set(
        [
          config.AI_MODEL,
          ...(modelCatalog[config.AI_PROVIDER ?? ""] ?? []),
        ].filter((v): v is string => !!v),
      ),
    ],
  };
}
export async function validateStrategySelection(
  db: pg.PoolClient,
  tid: string,
  strategy: string,
  customId: string | null,
  ai: unknown,
) {
  if (strategy === "custom-v1.0") {
    if (
      !customId ||
      !(
        await db.query(
          "SELECT 1 FROM custom_strategies WHERE tenant_id=$1 AND id=$2",
          [tid, customId],
        )
      ).rowCount
    )
      throw Error("CUSTOM_STRATEGY_REQUIRED");
  } else if (customId) throw Error("CUSTOM_STRATEGY_NOT_APPLICABLE");
  if (strategy === "ai-v1.0") {
    const selection = aiStrategyConfig.parse(ai),
      available = await aiModels(db);
    if (!available.configured) throw Error("AI_PROVIDER_NOT_CONFIGURED");
    if (!available.models.includes(selection.model))
      throw Error("AI_MODEL_NOT_ALLOWED");
  }
}
export function registerStrategyRoutes(app: FastifyInstance) {
  app.get("/api/strategies", (req) =>
    tenant(
      req.identity!.tenantId,
      async (db) =>
        (
          await db.query(
            "SELECT * FROM custom_strategies WHERE tenant_id=$1 ORDER BY created_at DESC,id",
            [req.identity!.tenantId],
          )
        ).rows,
    ),
  );
  app.get("/api/strategies/models", () => aiModels());
  app.post("/api/strategies", async (req, reply) => {
    const v = z
        .strictObject({
          name: z.string().trim().min(1).max(80),
          previousVersionId: z.uuid().optional(),
          rules: rulesSchema,
        })
        .parse(req.body),
      tid = req.identity!.tenantId;
    return tenant(tid, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "strategy:" + tid,
      ]);
      const previous = v.previousVersionId
        ? (
            await db.query(
              "SELECT * FROM custom_strategies WHERE tenant_id=$1 AND id=$2",
              [tid, v.previousVersionId],
            )
          ).rows[0]
        : null;
      if (v.previousVersionId && !previous)
        return reply.code(404).send({ error: "NOT_FOUND" });
      const id = randomUUID(),
        family = previous?.family_id ?? id;
      const version = Number(
        (
          await db.query(
            "SELECT COALESCE(max(version),0)+1 AS version FROM custom_strategies WHERE tenant_id=$1 AND family_id=$2",
            [tid, family],
          )
        ).rows[0].version,
      );
      await db.query(
        "INSERT INTO custom_strategies(id,tenant_id,family_id,name,version,rules) VALUES($1,$2,$3,$4,$5,$6)",
        [id, tid, family, v.name, version, JSON.stringify(v.rules)],
      );
      await audit(db, tid, "STRATEGY_VERSION_CREATED", {
        id,
        version,
        name: v.name,
      });
      reply.code(201);
      return { id, version };
    });
  });
}
