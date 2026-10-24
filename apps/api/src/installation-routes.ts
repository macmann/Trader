import type { FastifyInstance } from "fastify";
import { randomUUID, createHash } from "node:crypto";
import { hash, argon2id, verify } from "argon2";
import { z } from "zod";
import { pool, tenant, audit } from "./db.ts";
import {
  settingsSchema,
  savedSettings,
  runtimeConfiguration,
  publicSettings,
  publicSetupStatus,
  isOperator,
  sealSettings,
} from "./installation.ts";
import { validateMailConfiguration } from "./mail.ts";
import { configuredProvider } from "../../../packages/ai-providers/src/index.ts";
export function registerInstallationRoutes(app: FastifyInstance) {
  app.get("/api/setup/status", publicSetupStatus);
  app.post(
    "/api/setup",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (process.env.INSTALLATION_SETUP_ENABLED !== "true")
        return reply.code(403).send({ error: "SETUP_UNAVAILABLE" });
      const v = z
        .strictObject({
          token: z.string().regex(/^[a-f0-9]{64}$/),
          email: z
            .email()
            .max(254)
            .transform((v) => v.toLowerCase()),
          password: z.string().min(12).max(128),
        })
        .parse(req.body);
      const result = await pool.query(
        "SELECT claim_installation($1,$2,$3,$4,$5) AS claimed",
        [
          createHash("sha256").update(v.token).digest("hex"),
          randomUUID(),
          v.email,
          await hash(v.password, { type: argon2id }),
          randomUUID(),
        ],
      );
      if (!result.rows[0].claimed)
        return reply.code(403).send({ error: "SETUP_UNAVAILABLE" });
      return reply.code(201).send({
        message:
          "Administrator created. Sign in to configure your installation.",
      });
    },
  );
  app.get("/api/admin/settings", async (req, reply) => {
    if (!(await isOperator(req.identity!.userId)))
      return reply.code(403).send({ error: "PLATFORM_ADMIN_REQUIRED" });
    return publicSettings(await runtimeConfiguration());
  });
  app.put(
    "/api/admin/settings",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!(await isOperator(req.identity!.userId)))
        return reply.code(403).send({ error: "PLATFORM_ADMIN_REQUIRED" });
      const { password, settings, acknowledgeTestnetExecution } = z
        .strictObject({
          password: z.string().max(128),
          acknowledgeTestnetExecution: z.boolean().optional(),
          settings: settingsSchema,
        })
        .parse(req.body);
      const user = (
        await pool.query("SELECT password_hash FROM users WHERE id=$1", [
          req.identity!.userId,
        ])
      ).rows[0];
      if (!(await verify(user.password_hash, password)))
        return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
      return tenant(req.identity!.tenantId, async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(72723252)");
        const previous = await savedSettings(db);
        const next = { ...previous, ...settings };
        if (
          next.TRADING_EXECUTION_ENABLED === "true" &&
          previous.TRADING_EXECUTION_ENABLED !== "true" &&
          acknowledgeTestnetExecution !== true
        )
          return reply
            .code(400)
            .send({ error: "TESTNET_EXECUTION_ACKNOWLEDGEMENT_REQUIRED" });
        const effective = {
          ...process.env,
          ...next,
          TRADING_EXECUTION_ENABLED: next.TRADING_EXECUTION_ENABLED ?? "false",
        };
        try {
          validateMailConfiguration(effective);
          if (
            effective.AI_PROVIDER &&
            effective.AI_PROVIDER !== "disabled" &&
            !configuredProvider(effective)
          )
            throw Error();
        } catch {
          return reply
            .code(400)
            .send({ error: "INCOMPLETE_PROVIDER_CONFIGURATION" });
        }
        await db.query(
          "INSERT INTO platform_settings(encrypted_value) VALUES($1) ON CONFLICT(singleton) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value,updated_at=now()",
          [sealSettings(next)],
        );
        await audit(db, req.identity!.tenantId, "PLATFORM_SETTINGS_CHANGED", {
          fields: Object.keys(settings),
          userId: req.identity!.userId,
        });
        if (
          previous.TRADING_EXECUTION_ENABLED !==
            next.TRADING_EXECUTION_ENABLED &&
          settings.TRADING_EXECUTION_ENABLED !== undefined
        )
          await audit(db, req.identity!.tenantId, "TESTNET_EXECUTION_CHANGED", {
            userId: req.identity!.userId,
            enabled: next.TRADING_EXECUTION_ENABLED === "true",
          });
        return publicSettings(effective);
      });
    },
  );
}
