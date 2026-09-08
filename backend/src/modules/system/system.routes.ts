import { setStage } from "../../shared/logger.js";
import type { FastifyInstance } from "fastify";

import type { Database } from "../../shared/db.js";

export async function registerSystemRoutes(app: FastifyInstance, sql?: Database) {
  app.get("/health", async () => ({ status: "ok" }));

  if (sql) {
    app.get("/ready", async (_request, reply) => {
      try {
        setStage("health.database_probe");
        await sql`SELECT 1`;
        return { status: "ready" };
      } catch (err) {
        _request.log.error({ event: "health.database_failed", err }, "Database readiness check failed");
        return reply.code(503).send({ status: "unavailable" });
      }
    });
  }
}
