import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verify } from "argon2";
import { pool } from "./db.ts";
import { userContext, plans } from "./platform.ts";
import { isOperator } from "./installation.ts";
export function registerAdminUserRoutes(app: FastifyInstance) {
  app.get("/api/admin/users", async (req, reply) => {
    if (!(await isOperator(req.identity!.userId)))
      return reply.code(403).send({ error: "PLATFORM_ADMIN_REQUIRED" });
    const { search, offset, limit } = z
      .object({
        search: z.string().trim().max(200).default(""),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(req.query);
    return userContext(req.identity!.userId, async (db) => ({
      ...(
        await db.query("SELECT admin_account_directory($1,$2,$3) AS result", [
          search,
          limit,
          offset,
        ])
      ).rows[0].result,
      plans,
      offset,
      limit,
    }));
  });
  app.patch(
    "/api/admin/workspaces/:id/plan",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!(await isOperator(req.identity!.userId)))
        return reply.code(403).send({ error: "PLATFORM_ADMIN_REQUIRED" });
      const id = z.uuid().parse((req.params as { id: string }).id),
        { plan, password } = z
          .strictObject({
            plan: z.enum(["FREE", "BASIC", "PRO"]).nullable(),
            password: z.string().min(1).max(128),
          })
          .parse(req.body);
      const actor = (
        await pool.query("SELECT password_hash FROM users WHERE id=$1", [
          req.identity!.userId,
        ])
      ).rows[0];
      if (!actor || !(await verify(actor.password_hash, password)))
        return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
      return userContext(req.identity!.userId, async (db) => {
        const result = (
          await db.query("SELECT admin_set_workspace_plan($1,$2) AS result", [
            id,
            plan,
          ])
        ).rows[0].result;
        if (result.error)
          return reply
            .code(result.error === "NOT_FOUND" ? 404 : 409)
            .send(result);
        return result;
      });
    },
  );
}
