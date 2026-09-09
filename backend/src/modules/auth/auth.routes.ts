import type { FastifyInstance } from "fastify";

import { clearSessionCookie, createSessionCookie, passwordMatches, sessionStatus, type AuthConfig } from "./auth.js";

export async function registerAuthRoutes(app: FastifyInstance, config: AuthConfig) {
  app.get("/auth/session", async (request) => {
    const status = sessionStatus(request.headers.cookie, config);
    request.log.info({ event: "auth.session_checked", authenticated: status === "valid" }, "Authentication session checked");
    return { authenticated: status === "valid" };
  });

  app.post<{ Body: { password?: unknown } }>("/auth/login", async (request, reply) => {
    const password = request.body?.password;
    if (typeof password !== "string" || !passwordMatches(password, config)) {
      request.log.warn({ event: "auth.login_rejected", reason: "invalid_password" }, "Login rejected");
      return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "비밀번호가 올바르지 않습니다." } });
    }
    reply.header("set-cookie", createSessionCookie(config));
    request.log.info({ event: "auth.login_succeeded" }, "Login succeeded");
    return { authenticated: true };
  });

  app.post("/auth/logout", async (request, reply) => {
    reply.header("set-cookie", clearSessionCookie(config));
    request.log.info({ event: "auth.logout" }, "Logged out");
    return { authenticated: false };
  });
}
