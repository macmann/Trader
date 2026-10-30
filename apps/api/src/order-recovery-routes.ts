import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tenant, audit } from "./db.ts";
import { lockPortfolio } from "./portfolio.ts";
export function registerOrderRecoveryRoutes(app: FastifyInstance) {
  app.post("/api/bots/:id/recover-missing-order", async (req, reply) => {
    const id = z.uuid().parse((req.params as { id: string }).id);
    const { orderId } = z
      .object({
        orderId: z.uuid(),
        confirmedNoExchangeActivity: z.literal(true),
      })
      .parse(req.body);
    const identity = req.identity!,
      tid = identity.tenantId;
    if (!["OWNER", "ADMIN"].includes(identity.role))
      return reply.code(403).send({ error: "ROLE_FORBIDDEN" });
    if (Date.now() - identity.reauthenticatedAt.getTime() >= 300000)
      return reply.code(403).send({ error: "REAUTHENTICATION_REQUIRED" });
    return tenant(tid, async (db) => {
      await lockPortfolio(db, tid);
      const b = (
        await db.query(
          "SELECT b.*,c.provider,c.environment,c.status AS connection_status FROM bots b JOIN exchange_connections c ON c.id=b.connection_id AND c.tenant_id=b.tenant_id WHERE b.tenant_id=$1 AND b.id=$2 FOR UPDATE OF b,c",
          [tid, id],
        )
      ).rows[0];
      if (!b) return reply.code(404).send({ error: "NOT_FOUND" });
      if (
        b.provider !== "OKX" ||
        b.environment !== "TESTNET" ||
        b.market_type !== "LINEAR" ||
        b.status === "ARCHIVED" ||
        b.connection_status !== "CONNECTED"
      )
        return reply.code(409).send({ error: "RECOVERY_NOT_AVAILABLE" });
      const o = (
        await db.query(
          "SELECT * FROM orders WHERE tenant_id=$1 AND bot_id=$2 AND id=$3 FOR UPDATE",
          [tid, id, orderId],
        )
      ).rows[0];
      if (!o) return reply.code(404).send({ error: "NOT_FOUND" });
      if (o.state !== "UNKNOWN" || o.exchange_id || o.submitted_at)
        return reply
          .code(409)
          .send({ error: "ORDER_NOT_ELIGIBLE_FOR_RECOVERY" });
      await db.query(
        "UPDATE orders SET recovery_requested_at=now(),updated_at=now(),recovery_confirmed_by=$3 WHERE tenant_id=$1 AND id=$2",
        [tid, orderId, identity.userId],
      );
      await db.query(
        "UPDATE bots SET status='STOPPED',execution_resume_requested=false WHERE tenant_id=$1 AND id=$2",
        [tid, id],
      );
      await db.query(
        "UPDATE bot_runs SET stopped_at=now(),stop_reason='ORDER_RECOVERY' WHERE tenant_id=$1 AND bot_id=$2 AND stopped_at IS NULL",
        [tid, id],
      );
      await audit(db, tid, "MISSING_ORDER_RECOVERY_REQUESTED", {
        botId: id,
        orderId,
        actorUserId: identity.userId,
        confirmedNoExchangeActivity: true,
      });
      return { status: "REQUESTED", botStatus: "STOPPED" };
    });
  });
}
