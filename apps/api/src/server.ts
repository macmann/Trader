import { schemaReady } from "../../../scripts/database-ready.ts";
import { registerInstallationRoutes } from "./installation-routes.ts";
import { runtimeConfiguration, isOperator } from "./installation.ts";
import {
  deliverAccountLink,
  validateMailConfiguration,
  validatePublicOrigin,
  MailDeliveryError,
} from "./mail.ts";
import {
  exchangeAdapter,
  providers,
} from "../../../packages/exchanges/src/index.ts";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { hash, verify, argon2id } from "argon2";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { stat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import { pool, tenant, audit } from "./db.ts";
import { registerIntelligenceRoutes } from "./intelligence-routes.ts";
import { registerPlatformRoutes } from "./platform-routes.ts";
import { userContext, allowed, entitlements } from "./platform.ts";
import { registerAdvancedRoutes } from "./advanced-routes.ts";
import {
  symbolSchema,
  strategySchema,
  advancedConfig,
  configurationVeto,
} from "../../../packages/trading/src/index.ts";
import {
  lockPortfolio,
  portfolioSnapshot,
  allocationReasons,
} from "./portfolio.ts";
import { AIError } from "../../../packages/ai-core/src/index.ts";
import {
  botConfig,
  encrypt,
  ExchangeError,
} from "../../../packages/core/src/index.ts";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("hex");
const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  password: z.string().min(12).max(128),
});
const production = process.env.NODE_ENV === "production";
const origin = validatePublicOrigin();
validateMailConfiguration();
if (!process.env.APP_ENCRYPTION_KEY?.match(/^[a-f0-9]{64}$/i))
  throw Error("APP_ENCRYPTION_KEY must be a 32-byte hex key");
export const app = Fastify({
  trustProxy: production ? (_address: string, hop: number) => hop === 0 : false,
  logger: {
    redact: [
      "req.headers.cookie",
      "req.headers.authorization",
      "res.headers.set-cookie",
    ],
  },
  disableRequestLogging: true,
  bodyLimit: 16384,
});
await app.register(cookie);
await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
type Identity = {
  role: string;
  userId: string;
  tenantId: string;
  email: string;
  verified: boolean;
  token: string;
  csrf: string;
  reauthenticatedAt: Date;
};
declare module "fastify" {
  interface FastifyRequest {
    identity: Identity | null;
  }
}
app.decorateRequest("identity", null);
app.addHook("onResponse", async (req, reply) => {
  req.log.info(
    { route: req.routeOptions.url, status: reply.statusCode },
    "Request completed",
  );
});
app.addHook("onRequest", async (req, reply) => {
  if (!req.routeOptions.url?.startsWith("/api/")) return;
  reply.header("Cache-Control", "no-store");
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers.origin !== origin &&
    req.routeOptions.url !== "/api/billing/gateway"
  )
    return reply.code(403).send({ error: "ORIGIN_REJECTED" });
  const token = req.cookies.session;
  if (token) {
    const r = await pool.query(
      "SELECT s.*,u.email,u.verified,w.id AS tenant_id FROM sessions s JOIN users u ON u.id=s.user_id JOIN workspaces w ON w.owner_id=u.id AND w.kind='PERSONAL' WHERE token_hash=$1 AND expires_at>now()",
      [digest(token)],
    );
    if (r.rows[0]) {
      const v = r.rows[0];
      const membership = await userContext(
        v.user_id,
        async (db) =>
          (
            await db.query(
              "SELECT tenant_id,role FROM workspace_members WHERE user_id=$1 ORDER BY (tenant_id=$2) DESC,(tenant_id=$3) DESC LIMIT 1",
              [v.user_id, v.active_tenant_id ?? v.tenant_id, v.tenant_id],
            )
          ).rows[0],
      );
      if (!membership)
        return reply.code(401).send({ error: "WORKSPACE_ACCESS_REVOKED" });
      req.identity = {
        role: membership.role,
        userId: v.user_id,
        tenantId: membership.tenant_id,
        email: v.email,
        verified: v.verified,
        token,
        csrf: v.csrf,
        reauthenticatedAt: v.reauthenticated_at,
      };
    }
  }
  const publicPaths = [
    "/api/health",
    "/api/setup/status",
    "/api/setup",
    "/api/billing/gateway",
    "/api/auth/register",
    "/api/auth/login",
    "/api/auth/verify",
    "/api/auth/reset-request",
    "/api/auth/reset",
  ];
  if (publicPaths.includes(req.routeOptions.url!)) return;
  if (!req.identity)
    return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
  if (
    !["GET", "HEAD"].includes(req.method) &&
    req.headers["x-csrf-token"] !== req.identity.csrf
  )
    return reply.code(403).send({ error: "CSRF_REJECTED" });
  if (!allowed(req.identity.role, req.method, req.routeOptions.url ?? ""))
    return reply.code(403).send({ error: "ROLE_FORBIDDEN" });
  if (!req.routeOptions.url?.startsWith("/api/auth/") && !req.identity.verified)
    return reply.code(403).send({ error: "EMAIL_VERIFICATION_REQUIRED" });
});
app.setErrorHandler((err, req, reply) => {
  if (err instanceof MailDeliveryError)
    return reply.code(503).send({ error: "EMAIL_DELIVERY_UNAVAILABLE" });
  if (err instanceof AIError) return reply.code(503).send({ error: err.code });
  if (err instanceof ZodError)
    return reply.code(400).send({
      error: "VALIDATION_ERROR",
      details: err.issues.map((v) => ({ path: v.path, message: v.message })),
    });
  if (err instanceof ExchangeError)
    return reply.code(422).send({ error: err.status });
  const e = err as { code?: string; statusCode?: number };
  if (e.code === "23505")
    return reply.code(409).send({ error: "ALREADY_EXISTS" });
  if (
    ["CONNECTION_PLAN_LIMIT", "MONTHLY_QUOTA_EXCEEDED"].includes(
      (err as Error).message,
    )
  )
    return reply
      .code(e.statusCode ?? 409)
      .send({ error: (err as Error).message });
  if (e.statusCode && e.statusCode < 500)
    return reply.code(e.statusCode).send({ error: "REQUEST_REJECTED" });
  req.log.error(
    { errorType: err instanceof Error ? err.name : "Unknown" },
    "Request failed",
  );
  return reply.code(500).send({ error: "INTERNAL_ERROR" });
});
async function sendLink(
  userId: string,
  email: string,
  kind: "verify" | "reset",
) {
  const token = secret();
  await pool.query(
    "INSERT INTO auth_tokens(token_hash,user_id,kind,expires_at) VALUES($1,$2,$3,now()+interval '30 minutes')",
    [digest(token), userId, kind],
  );
  try {
    await deliverAccountLink(email, kind, `${origin}/?${kind}=${token}`);
  } catch (e) {
    await pool.query("DELETE FROM auth_tokens WHERE token_hash=$1", [
      digest(token),
    ]);
    throw e;
  }
}
app.get("/api/health", async (_req, reply) => {
  try {
    if (!(await schemaReady(pool))) throw Error();
    return { status: "ok", liveTrading: false };
  } catch {
    return reply.code(503).send({ status: "not_ready", liveTrading: false });
  }
});
app.post(
  "/api/auth/register",
  { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
  async (req, reply) => {
    const mail = await runtimeConfiguration();
    if (
      (mail.MAIL_MODE ?? (production ? "disabled" : "development")) ===
      "disabled"
    )
      return reply
        .code(503)
        .send({ error: "REGISTRATION_UNAVAILABLE_UNTIL_EMAIL_CONFIGURED" });
    const v = credentials.parse(req.body),
      id = randomUUID(),
      workspace = randomUUID(),
      passwordHash = await hash(v.password, { type: argon2id });
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",
        [id, v.email, passwordHash],
      );
      await db.query("INSERT INTO workspaces(id,owner_id) VALUES($1,$2)", [
        workspace,
        id,
      ]);
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
    await sendLink(id, v.email, "verify");
    return reply
      .code(201)
      .send({ message: "Check your email to verify your account." });
  },
);
app.post(
  "/api/auth/login",
  { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
  async (req, reply) => {
    const v = credentials.parse(req.body),
      r = await pool.query("SELECT * FROM users WHERE email=$1", [v.email]),
      u = r.rows[0],
      ok = u ? await verify(u.password_hash, v.password) : false;
    await pool.query(
      "INSERT INTO login_history(user_id,succeeded) VALUES($1,$2)",
      [u?.id ?? null, ok],
    );
    if (!ok) return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    const token = secret(),
      csrf = secret();
    await pool.query(
      "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '24 hours')",
      [digest(token), u.id, csrf],
    );
    reply.setCookie("session", token, {
      httpOnly: true,
      secure: production,
      sameSite: "strict",
      path: "/",
      maxAge: 86400,
    });
    return { csrf };
  },
);
app.get("/api/auth/me", async (req) => ({
  platformAdmin: await isOperator(req.identity!.userId),
  role: req.identity!.role,
  tenantId: req.identity!.tenantId,
  email: req.identity!.email,
  verified: req.identity!.verified,
  csrf: req.identity!.csrf,
}));
app.post("/api/auth/logout", async (req, reply) => {
  await pool.query("DELETE FROM sessions WHERE token_hash=$1", [
    digest(req.identity!.token),
  ]);
  reply.clearCookie("session", { path: "/" });
  return { ok: true };
});
app.post("/api/auth/verify", async (req, reply) => {
  const { token } = z.object({ token: z.string().length(64) }).parse(req.body);
  const r = await pool.query(
    "DELETE FROM auth_tokens WHERE token_hash=$1 AND kind='verify' AND expires_at>now() RETURNING user_id",
    [digest(token)],
  );
  if (!r.rows[0])
    return reply.code(400).send({ error: "TOKEN_INVALID_OR_EXPIRED" });
  await pool.query("UPDATE users SET verified=true WHERE id=$1", [
    r.rows[0].user_id,
  ]);
  return { ok: true };
});
app.post(
  "/api/auth/resend-verification",
  { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } },
  async (req) => {
    await sendLink(req.identity!.userId, req.identity!.email, "verify");
    return { ok: true };
  },
);
app.post(
  "/api/auth/reset-request",
  { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } },
  async (req) => {
    const { email } = z
        .object({ email: z.email().transform((v) => v.toLowerCase()) })
        .parse(req.body),
      r = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    if (r.rows[0]) {
      try {
        await sendLink(r.rows[0].id, email, "reset");
      } catch (e) {
        if (!(e instanceof MailDeliveryError)) throw e;
        req.log.warn(
          { event: "RESET_EMAIL_DELIVERY_UNAVAILABLE" },
          "Password reset delivery unavailable",
        );
      }
    }
    return { message: "If the account exists, a reset link has been sent." };
  },
);
app.post("/api/auth/reset", async (req, reply) => {
  const v = z
    .object({
      token: z.string().length(64),
      password: z.string().min(12).max(128),
    })
    .parse(req.body);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const r = await db.query(
      "DELETE FROM auth_tokens WHERE token_hash=$1 AND kind='reset' AND expires_at>now() RETURNING user_id",
      [digest(v.token)],
    );
    if (!r.rows[0]) {
      await db.query("ROLLBACK");
      return reply.code(400).send({ error: "TOKEN_INVALID_OR_EXPIRED" });
    }
    await db.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
      await hash(v.password, { type: argon2id }),
      r.rows[0].user_id,
    ]);
    await db.query("DELETE FROM sessions WHERE user_id=$1", [
      r.rows[0].user_id,
    ]);
    await db.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
});
app.post(
  "/api/auth/reauthenticate",
  { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
  async (req, reply) => {
    const { password } = z
        .object({ password: z.string().max(128) })
        .parse(req.body),
      u = await pool.query("SELECT password_hash FROM users WHERE id=$1", [
        req.identity!.userId,
      ]);
    if (!(await verify(u.rows[0].password_hash, password)))
      return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    await pool.query(
      "UPDATE sessions SET reauthenticated_at=now() WHERE token_hash=$1",
      [digest(req.identity!.token)],
    );
    return { ok: true };
  },
);
app.get(
  "/api/auth/sessions",
  async (req) =>
    (
      await pool.query(
        "SELECT created_at,expires_at,token_hash=$2 AS current FROM sessions WHERE user_id=$1 AND expires_at>now()",
        [req.identity!.userId, digest(req.identity!.token)],
      )
    ).rows,
);
app.post("/api/auth/revoke-other-sessions", async (req) => {
  await pool.query("DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2", [
    req.identity!.userId,
    digest(req.identity!.token),
  ]);
  return { ok: true };
});
app.get(
  "/api/auth/login-history",
  async (req) =>
    (
      await pool.query(
        "SELECT succeeded,created_at FROM login_history WHERE user_id=$1 ORDER BY id DESC LIMIT 50",
        [req.identity!.userId],
      )
    ).rows,
);
function recent(req: { identity: Identity | null }) {
  return Date.now() - req.identity!.reauthenticatedAt.getTime() < 300000;
}
app.get("/api/exchanges", async () => ({ providers }));
app.get("/api/connections", async (req) =>
  tenant(
    req.identity!.tenantId,
    async (db) =>
      (
        await db.query(
          "SELECT id,name,provider,environment,status,permissions,last_verified_at FROM exchange_connections WHERE tenant_id=$1",
          [req.identity!.tenantId],
        )
      ).rows,
  ),
);
app.post("/api/connections", async (req, reply) => {
  if (!recent(req))
    return reply.code(403).send({ error: "REAUTHENTICATION_REQUIRED" });
  const v = z
    .object({
      provider: z.enum(["BYBIT", "OKX"]).default("BYBIT"),
      passphrase: z.string().min(1).max(256).optional(),
      name: z.string().min(1).max(80),
      environment: z.enum(["TESTNET", "LIVE"]),
      apiKey: z.string().min(8).max(256),
      apiSecret: z.string().min(8).max(256),
    })
    .parse(req.body);
  if (v.environment === "LIVE")
    return reply
      .code(403)
      .send({ error: "LIVE_CONNECTIONS_DISABLED_IN_MVP_PREVIEW" });
  if (v.provider === "OKX" && !v.passphrase)
    return reply.code(400).send({ error: "PASSPHRASE_REQUIRED" });
  const adapter = exchangeAdapter(v.provider, v.environment, v),
    permissions = await adapter.validateCredentials(),
    id = randomUUID(),
    tid = req.identity!.tenantId;
  await tenant(tid, async (db) => {
    await lockPortfolio(db, tid);
    const e = await entitlements(db, tid);
    if (
      Number(
        (
          await db.query(
            "SELECT count(*) AS n FROM exchange_connections WHERE tenant_id=$1 AND status<>'DISCONNECTED'",
            [tid],
          )
        ).rows[0].n,
      ) >= e.limits.connections
    )
      throw Object.assign(Error("CONNECTION_PLAN_LIMIT"), { statusCode: 409 });
    await db.query(
      "INSERT INTO exchange_connections(id,tenant_id,name,environment,credentials,status,permissions,provider) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        id,
        tid,
        v.name,
        v.environment,
        encrypt(
          {
            apiKey: v.apiKey,
            apiSecret: v.apiSecret,
            ...(v.provider === "OKX" ? { passphrase: v.passphrase } : {}),
          },
          process.env.APP_ENCRYPTION_KEY!,
          `${tid}:${id}:${v.environment}`,
        ),
        "CONNECTED",
        JSON.stringify(permissions),
        v.provider,
      ],
    );
    await audit(db, tid, "EXCHANGE_CONNECTED", {
      id,
      environment: v.environment,
    });
  });
  return reply.code(201).send({ id, status: "CONNECTED", permissions });
});
app.delete("/api/connections/:id", async (req, reply) => {
  if (!recent(req))
    return reply.code(403).send({ error: "REAUTHENTICATION_REQUIRED" });
  const id = z.uuid().parse((req.params as any).id),
    tid = req.identity!.tenantId;
  return tenant(tid, async (db) => {
    await lockPortfolio(db, tid);
    const r = await db.query(
      "SELECT id FROM exchange_connections WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
      [id, tid],
    );
    if (!r.rowCount) return reply.code(404).send({ error: "NOT_FOUND" });
    const exposed = (
      await db.query(
        "SELECT 1 FROM bots b LEFT JOIN positions p ON p.bot_id=b.id WHERE b.connection_id=$1 AND b.tenant_id=$2 AND (COALESCE(p.quantity,0)>0 OR EXISTS(SELECT 1 FROM orders o WHERE o.bot_id=b.id AND o.tenant_id=b.tenant_id AND o.state NOT IN ('Filled','Cancelled','Rejected','Deactivated','PartiallyFilledCanceled','FILLED','CANCELLED','REJECTED'))) LIMIT 1",
        [id, tid],
      )
    ).rowCount;
    if (exposed)
      return reply
        .code(409)
        .send({ error: "OPEN_EXPOSURE_PREVENTS_DISCONNECT" });
    await db.query(
      "UPDATE bots SET status='STOPPED' WHERE connection_id=$1 AND tenant_id=$2 AND status<>'ARCHIVED'",
      [id, tid],
    );
    await db.query(
      "UPDATE exchange_connections SET status='DISCONNECTED',credentials='' WHERE id=$1 AND tenant_id=$2",
      [id, tid],
    );
    await audit(db, tid, "EXCHANGE_DISCONNECTED", { id });
    return { ok: true };
  });
});
app.get("/api/bots", async (req) =>
  tenant(
    req.identity!.tenantId,
    async (db) =>
      (
        await db.query(
          "SELECT b.*,c.environment,c.status AS connection_status,p.quantity,p.cost,p.realized_pnl,p.fees FROM bots b JOIN exchange_connections c ON c.id=b.connection_id LEFT JOIN positions p ON p.bot_id=b.id WHERE b.tenant_id=$1 ORDER BY b.created_at DESC",
          [req.identity!.tenantId],
        )
      ).rows,
  ),
);
app.post("/api/bots", async (req, reply) => {
  const v = z
      .strictObject({
        name: z.string().min(1).max(80),
        marketplaceVersionId: z.uuid().optional(),
        connectionId: z.uuid(),
        config: botConfig,
        symbol: symbolSchema.default("BTCUSDT"),
        strategyVersion: strategySchema.default("trend-v1.0"),
        advancedConfig: advancedConfig.default(() => advancedConfig.parse({})),
      })
      .parse(req.body),
    tid = req.identity!.tenantId,
    id = randomUUID();
  return tenant(tid, async (db) => {
    await lockPortfolio(db, tid);
    if (v.marketplaceVersionId) {
      const version = (
        await db.query(
          "SELECT v.* FROM marketplace_versions v JOIN strategy_subscriptions s ON s.version_id=v.id AND s.tenant_id=$1 WHERE v.id=$2",
          [tid, v.marketplaceVersionId],
        )
      ).rows[0];
      if (!version)
        return reply.code(404).send({ error: "SUBSCRIBED_VERSION_REQUIRED" });
      v.config = version.config;
      v.advancedConfig = version.advanced_config;
      v.strategyVersion = version.strategy_version;
      v.symbol = version.symbol;
    }
    const entitlement = await entitlements(db, tid);
    if (
      Number(
        (
          await db.query(
            "SELECT count(*) AS n FROM bots WHERE tenant_id=$1 AND status<>'ARCHIVED'",
            [tid],
          )
        ).rows[0].n,
      ) >= entitlement.limits.bots
    )
      return reply.code(409).send({ error: "BOT_PLAN_LIMIT" });
    const invalid = configurationVeto(v.strategyVersion, v.advancedConfig);
    if (invalid) return reply.code(400).send({ error: invalid });
    const reasons = allocationReasons(
      await portfolioSnapshot(db, tid),
      v.config.capital,
      v.connectionId,
      v.symbol,
    );
    if (reasons.length)
      return reply
        .code(409)
        .send({ error: "PORTFOLIO_ALLOCATION_REJECTED", reasons });
    const c = await db.query(
      "SELECT id FROM exchange_connections WHERE id=$1 AND tenant_id=$2 AND status='CONNECTED' AND environment='TESTNET'",
      [v.connectionId, tid],
    );
    if (!c.rowCount)
      return reply
        .code(400)
        .send({ error: "CONNECTED_TESTNET_EXCHANGE_REQUIRED" });
    await db.query(
      "INSERT INTO bots(id,tenant_id,connection_id,name,config,symbol,strategy_version,advanced_config,marketplace_version_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        id,
        tid,
        v.connectionId,
        v.name,
        JSON.stringify(v.config),
        v.symbol,
        v.strategyVersion,
        JSON.stringify(v.advancedConfig),
        v.marketplaceVersionId ?? null,
      ],
    );
    await db.query("INSERT INTO positions(bot_id,tenant_id) VALUES($1,$2)", [
      id,
      tid,
    ]);
    await audit(db, tid, "BOT_CREATED", { id });
    return reply.code(201).send({ id });
  });
});
app.post("/api/bots/:id/:action", async (req, reply) => {
  const p = z
      .object({ id: z.uuid(), action: z.enum(["start", "pause", "stop"]) })
      .parse(req.params),
    tid = req.identity!.tenantId;
  return tenant(tid, async (db) => {
    await lockPortfolio(db, tid);
    const b = await db.query(
      "SELECT b.*,c.status AS connection_status FROM bots b JOIN exchange_connections c ON c.id=b.connection_id WHERE b.id=$1 AND b.tenant_id=$2 FOR UPDATE OF b",
      [p.id, tid],
    );
    if (!b.rowCount) return reply.code(404).send({ error: "NOT_FOUND" });
    if (b.rows[0].status === "ARCHIVED")
      return reply.code(409).send({ error: "BOT_ARCHIVED" });
    if (p.action === "start" && b.rows[0].connection_status !== "CONNECTED")
      return reply.code(409).send({ error: "EXCHANGE_NOT_CONNECTED" });
    const status = { start: "STARTING", pause: "PAUSED", stop: "STOPPED" }[
      p.action
    ];
    await db.query("UPDATE bots SET status=$1 WHERE id=$2 AND tenant_id=$3", [
      status,
      p.id,
      tid,
    ]);
    await audit(db, tid, `BOT_${p.action.toUpperCase()}`, { id: p.id });
    return { status };
  });
});
app.post("/api/stop-all", async (req) =>
  tenant(req.identity!.tenantId, async (db) => {
    await lockPortfolio(db, req.identity!.tenantId);
    await db.query(
      "UPDATE bots SET status='STOPPED' WHERE tenant_id=$1 AND status<>'ARCHIVED'",
      [req.identity!.tenantId],
    );
    await audit(db, req.identity!.tenantId, "ALL_BOTS_STOPPED");
    return { ok: true };
  }),
);
for (const table of ["signals", "orders", "audit_logs"] as const)
  app.get(`/api/${table}`, async (req) =>
    tenant(
      req.identity!.tenantId,
      async (db) =>
        (
          await db.query(
            `SELECT * FROM ${table} WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`,
            [req.identity!.tenantId],
          )
        ).rows,
    ),
  );
registerInstallationRoutes(app);
registerPlatformRoutes(app);
registerIntelligenceRoutes(app);
registerAdvancedRoutes(app);
const web = resolve(import.meta.dirname, "../../web/dist");
if (await stat(web).catch(() => null)) {
  const files = new Set(await readdir(resolve(web, "assets")));
  for (const [path, type] of [
    ["manifest.webmanifest", "application/manifest+json"],
    ["sw.js", "text/javascript"],
    ["icon.svg", "image/svg+xml"],
    ["offline.html", "text/html"],
  ])
    app.get("/" + path, async (_req, reply) =>
      reply
        .header("Cache-Control", "no-cache")
        .type(type)
        .send(await readFile(resolve(web, path))),
    );
  app.get("/", async (_req, reply) =>
    reply.type("text/html").send(await readFile(resolve(web, "index.html"))),
  );
  app.get("/assets/:filename", async (req, reply) => {
    const name = (req.params as { filename: string }).filename;
    if (!files.has(name)) return reply.code(404).send({ error: "NOT_FOUND" });
    return reply
      .type(
        name.endsWith(".js")
          ? "text/javascript"
          : name.endsWith(".css")
            ? "text/css"
            : "application/octet-stream",
      )
      .send(await readFile(resolve(web, "assets", name)));
  });
}
if (process.env.NODE_ENV !== "test") {
  const role = (
    await pool.query(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  if (role.rolsuper || role.rolbypassrls)
    throw Error("Runtime database role must enforce row-level security");
}
if (process.env.NODE_ENV !== "test")
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });

if (process.env.NODE_ENV !== "test") {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await pool.end();
  };
  process.once("SIGTERM", () => {
    void stop().catch(() => {
      process.exitCode = 1;
    });
  });
  process.once("SIGINT", () => {
    void stop().catch(() => {
      process.exitCode = 1;
    });
  });
}
