import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Decimal } from "decimal.js";
import { tenant, audit } from "./db.ts";
import { lockPortfolio, terminalStates } from "./portfolio.ts";
export function registerBotDeleteRoutes(app: FastifyInstance) {
  app.delete("/api/bots/:id", async (req, reply) => {
    const id = z.uuid().parse((req.params as { id: string }).id),
      tid = req.identity!.tenantId;
    return tenant(tid, async (db) => {
      await lockPortfolio(db, tid);
      const b = (
        await db.query(
          "SELECT b.*,c.status AS connection_status,c.reconciled_at FROM bots b JOIN exchange_connections c ON c.id=b.connection_id AND c.tenant_id=b.tenant_id WHERE b.id=$1 AND b.tenant_id=$2 FOR UPDATE OF b,c",
          [id, tid],
        )
      ).rows[0];
      if (!b) return reply.code(404).send({ error: "NOT_FOUND" });
      if (b.status === "ARCHIVED")
        return { status: "ARCHIVED", unchanged: true };
      const position = (
        await db.query(
          "SELECT quantity,cost FROM positions WHERE bot_id=$1 AND tenant_id=$2 FOR UPDATE",
          [id, tid],
        )
      ).rows[0];
      if (
        !position ||
        !new Decimal(position.quantity).isFinite() ||
        !new Decimal(position.cost).isFinite()
      )
        return reply.code(409).send({ error: "BOT_POSITION_STATE_MISSING" });
      if (
        !new Decimal(position.quantity).isZero() ||
        !new Decimal(position.cost).isZero()
      )
        return reply
          .code(409)
          .send({ error: "CLOSE_POSITION_BEFORE_DELETING_BOT" });
      if (
        (
          await db.query(
            "SELECT 1 FROM orders WHERE bot_id=$1 AND tenant_id=$2 AND NOT(state=ANY($3::text[])) LIMIT 1",
            [id, tid, terminalStates],
          )
        ).rowCount
      )
        return reply
          .code(409)
          .send({ error: "RESOLVE_ORDERS_BEFORE_DELETING_BOT" });
      const history = (
        await db.query(
          "SELECT max(updated_at) AS last_activity FROM orders WHERE bot_id=$1 AND tenant_id=$2 AND (submitted_at IS NOT NULL OR exchange_id IS NOT NULL OR EXISTS(SELECT 1 FROM executions e WHERE e.order_id=orders.id AND e.tenant_id=orders.tenant_id))",
          [id, tid],
        )
      ).rows[0].last_activity;
      const reconciled =
        b.market_type === "LINEAR" ? b.futures_reconciled_at : b.reconciled_at;
      // Settled, stopped bots can be removed even after an exchange is disconnected.
      // Require a reconciliation that covers the last external order state, not a fresh login.
      if (
        history &&
        (!reconciled || history.getTime() > reconciled.getTime() + 1000)
      )
        return reply.code(409).send({ error: "RECONCILE_BEFORE_DELETING_BOT" });
      await db.query(
        "UPDATE bots SET status='ARCHIVED',execution_resume_requested=false,deleted_at=now() WHERE id=$1 AND tenant_id=$2",
        [id, tid],
      );
      await db.query(
        "UPDATE bot_runs SET stopped_at=now(),stop_reason='DELETE' WHERE bot_id=$1 AND tenant_id=$2 AND stopped_at IS NULL",
        [id, tid],
      );
      await audit(db, tid, "BOT_DELETED", {
        botId: id,
        actorUserId: req.identity!.userId,
        name: b.name,
        previousStatus: b.status,
        historyRetained: true,
      });
      return { status: "ARCHIVED", historyRetained: true };
    });
  });
}
