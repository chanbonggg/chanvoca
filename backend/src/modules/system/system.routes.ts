import type { FastifyInstance } from "fastify";

import type { Database } from "../../shared/db.js";

export async function registerSystemRoutes(app: FastifyInstance, sql?: Database) {
  app.get("/health", async () => ({ status: "ok" }));

  if (sql) {
    app.get("/ready", async (_request, reply) => {
      try {
        await sql`SELECT 1`;
        return { status: "ready" };
      } catch {
        return reply.code(503).send({ status: "unavailable" });
      }
    });
  }
}
