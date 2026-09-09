import Fastify, { LogController } from "fastify";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { logger, logContext } from "./shared/logger.js";

import type { Database } from "./shared/db.js";
import { loadAuthConfig, sessionStatus, type AuthConfig } from "./modules/auth/auth.js";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import { registerDaysRoutes } from "./modules/days/days.routes.js";
import { registerNotificationRoutes } from "./modules/notifications/notifications.routes.js";
import { registerStudyRoutes } from "./modules/study/study.routes.js";
import { registerSystemRoutes } from "./modules/system/system.routes.js";

export function buildApp(sql?: Database, log = logger, authConfig: AuthConfig | null = loadAuthConfig()) {
  const app = Fastify({ loggerInstance: log, logController: new LogController({ disableRequestLogging: true }), genReqId: () => randomUUID() });
  app.addHook("onRequest", (request, reply, done) => {
    reply.header("x-request-id", request.id);
    const context = { log: log.child({ reqId: request.id, method: request.method, route: request.routeOptions.url ?? "unmatched" }) };
    request.log = context.log;
    logContext.run(context, () => {
      request.log.info({ event: "http.started" }, "Request started");
      done();
    });
  });
  app.addHook("onError", async (request, _reply, err) => {
    const fields = { event: "http.error", stage: logContext.getStore()?.stage, err };
    if ((err.statusCode ?? 500) >= 500) request.log.error(fields, "Request failed");
    else request.log.warn(fields, "Request rejected");
  });
  app.addHook("preHandler", async (request) => {
    const sessionId = (request.params as { sessionId?: unknown })?.sessionId;
    if (typeof sessionId === "string" && /^[0-9a-f-]{36}$/i.test(sessionId)) {
      request.log = request.log.child({ sessionId });
      const context = logContext.getStore();
      if (context) context.log = context.log.child({ sessionId });
    }
  });
  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?", 1)[0];
    if (!authConfig || path === "/api/health" || path === "/api/ready" || path.startsWith("/api/auth/")) return;
    const status = sessionStatus(request.headers.cookie, authConfig);
    if (status === "valid") return;
    request.log.warn({ event: "auth.session_rejected", reason: status }, "Session rejected");
    return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "로그인이 필요합니다." } });
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (reply.statusCode >= 400) {
      let errorCode: string | undefined;
      if (typeof payload === "string") {
        try { const parsed = JSON.parse(payload); errorCode = parsed.error?.code ?? parsed.code; } catch { /* Non-JSON response */ }
      }
      const fields = { event: "http.rejected", statusCode: reply.statusCode, errorCode, stage: logContext.getStore()?.stage };
      if (reply.statusCode >= 500) request.log.error(fields, "Error response");
      else request.log.warn(fields, "Rejected response");
    }
    return payload;
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info({ event: "http.completed", statusCode: reply.statusCode, durationMs: reply.elapsedTime }, "Request completed");
  });
  app.addHook("onTimeout", async (request) => { request.log.warn({ event: "http.timeout" }, "Request timed out"); });
  app.addHook("onRequestAbort", async (request) => { request.log.warn({ event: "http.aborted" }, "Client aborted request"); });
  app.register(multipart, { limits: { files: 1, fileSize: 10 * 1024 * 1024 } });

  app.register((instance) => registerSystemRoutes(instance, sql), { prefix: "/api" });
  if (authConfig) app.register((instance) => registerAuthRoutes(instance, authConfig), { prefix: "/api" });

  if (sql) {
    app.addHook("onClose", () => sql.end());
    app.register((instance) => registerDaysRoutes(instance, sql), { prefix: "/api/days" });
    app.register((instance) => registerNotificationRoutes(instance, sql), { prefix: "/api" });
    app.register((instance) => registerStudyRoutes(instance, sql), { prefix: "/api/study" });
  }

  return app;
}
