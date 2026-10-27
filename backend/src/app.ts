import Fastify, { LogController } from "fastify";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { logger, logContext } from "./shared/logger.js";

import type { Database } from "./shared/db.js";
import { authenticatedUser, loadAuthConfig, sessionToken, type AuthConfig } from "./modules/auth/auth.js";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import { registerDaysRoutes } from "./modules/days/days.routes.js";
import { registerNotificationRoutes } from "./modules/notifications/notifications.routes.js";
import { registerStudyRoutes } from "./modules/study/study.routes.js";
import { registerSystemRoutes } from "./modules/system/system.routes.js";

export function buildApp(sql?: Database, log = logger, authConfig: AuthConfig = loadAuthConfig()) {
  const app = Fastify({ loggerInstance: log, logController: new LogController({ disableRequestLogging: true }), genReqId: () => randomUUID() });
  app.decorateRequest("user", null);
  app.setErrorHandler((err, request, reply) => {
    const error = err as Error & { statusCode?: number; code?: string };
    const databaseFailure = /^(08|57P|ECONN|CONNECT_)/.test(error.code ?? "");
    const status = databaseFailure ? 503 : error.statusCode ?? 500;
    if (status === 503) reply.header("retry-after", 1);
    request.log.error({ event: "http.failure", err: error }, "Request failed");
    return reply.code(status).send({ error: { code: status >= 500 ? "SERVICE_UNAVAILABLE" : "INVALID_REQUEST", message: status >= 500 ? "서버 요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요." : "요청 형식이 올바르지 않습니다." } });
  });
  app.addHook("onRequest", (request, reply, done) => {
    reply.header("x-request-id", request.id);
    reply.header("cache-control", "no-store");
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
    if (path === "/api/health" || path === "/api/ready") return;
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin !== authConfig.origin) {
      return reply.code(403).send({ error: { code: "ORIGIN_REJECTED", message: "허용되지 않은 요청입니다." } });
    }
    const token = sessionToken(request.headers.cookie);
    if (token) {
      try {
        if (!sql) throw new Error("Authentication database unavailable.");
        request.user = await authenticatedUser(sql, token);
      } catch (err) {
        request.log.error({ event: "auth.storage_failed", err }, "Authentication unavailable");
        return reply.code(503).send({ error: { code: "AUTH_UNAVAILABLE", message: "인증 상태를 확인할 수 없습니다. 다시 시도하세요." } });
      }
    }
    if (request.user && request.headers["x-chanvoca-user"] && request.headers["x-chanvoca-user"] !== request.user.id) return reply.code(409).send({ error: { code: "AUTH_CHANGED", message: "계정이 변경되었습니다. 다시 확인하세요." } });
    const publicAuth = ["/api/auth/session", "/api/auth/login", "/api/auth/register", "/api/auth/logout"];
    if (publicAuth.includes(path) || request.user) return;
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
  app.register((instance) => registerAuthRoutes(instance, sql, authConfig), { prefix: "/api" });

  if (sql) {
    app.addHook("onClose", () => sql.end());
    app.register((instance) => registerDaysRoutes(instance, sql, authConfig.maxDailyCards), { prefix: "/api/days" });
    app.register((instance) => registerNotificationRoutes(instance, sql), { prefix: "/api" });
    app.register((instance) => registerStudyRoutes(instance, sql), { prefix: "/api/study" });
  }

  return app;
}
