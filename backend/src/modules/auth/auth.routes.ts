import type { FastifyInstance } from "fastify";
import type { Database } from "../../shared/db.js";
import { createInvite, requestUser, consumeRateLimit, hashPassword, issueSession, loginId, missingPasswordHash, passwordMatches, revokeSession, sessionCookie, sessionToken, tokenHash, validPassword, type AuthConfig } from "./auth.js";

export async function registerAuthRoutes(app: FastifyInstance, sql: Database | undefined, config: AuthConfig) {
  app.post("/auth/invites", async (request, reply) => {
    const user = requestUser(request);
    if (!sql) return reply.code(503).send(error("AUTH_UNAVAILABLE", "인증 저장소를 사용할 수 없습니다."));
    const retry = await consumeRateLimit(sql, `invite:user:${user.id}`, 10, 3600);
    if (retry) return reply.header("retry-after", retry).code(429).send(error("AUTH_RATE_LIMIT", "초대코드는 시간당 10개까지 만들 수 있습니다. 잠시 후 다시 시도하세요."));
    return reply.code(201).send({ inviteCode: await createInvite(sql) });
  });
  app.get("/auth/session", async (request) => ({ authenticated: Boolean(request.user), user: request.user ? { id: request.user.id, loginId: request.user.loginId } : null }));
  for (const mode of ["login", "register"] as const) {
    app.post<{ Body: { loginId?: unknown; password?: unknown; inviteCode?: unknown } }>(`/auth/${mode}`, { bodyLimit: 4096 }, async (request, reply) => {
      if (!sql) return reply.code(503).send(error("AUTH_UNAVAILABLE", "인증 저장소를 사용할 수 없습니다."));
      const ipRetry = await consumeRateLimit(sql, `${mode}:ip:${request.ip}`, mode === "login" ? 60 : 10, mode === "login" ? 900 : 3600);
      if (ipRetry) return reply.header("retry-after", ipRetry).code(429).send(error("AUTH_RATE_LIMIT", "요청이 많습니다. 잠시 후 다시 시도하세요."));
      const body = request.body;
      const id = loginId(body?.loginId);
      if (!id || !validPassword(body?.password)) return reply.code(400).send(error("INVALID_INPUT", "아이디는 영문·숫자·밑줄 3~32자, 비밀번호는 15~128자로 입력하세요."));
      const password = body.password;
      if (mode === "login") {
        const retry = await consumeRateLimit(sql, `login:id:${id}`, 10, 900);
        if (retry) return reply.header("retry-after", retry).code(429).send(error("AUTH_RATE_LIMIT", "요청이 많습니다. 잠시 후 다시 시도하세요."));
        const rows = await sql<{ user_id: string; password_hash: string }[]>`SELECT user_id, password_hash FROM auth_credentials WHERE login_id = ${id}`;
        const matches = await passwordMatches(password, rows[0]?.password_hash ?? await missingPasswordHash());
        if (!matches || !rows[0]) return reply.code(401).send(error("INVALID_CREDENTIALS", "아이디 또는 비밀번호가 올바르지 않습니다."));
        const token = await sql.begin(async (tx) => {
          const current = await tx<{ password_hash: string }[]>`SELECT password_hash FROM auth_credentials WHERE user_id = ${rows[0].user_id} FOR UPDATE`;
          if (current[0]?.password_hash !== rows[0].password_hash) return null;
          return issueSession(tx, rows[0].user_id, sessionToken(request.headers.cookie));
        });
        if (!token) return reply.code(401).send(error("INVALID_CREDENTIALS", "아이디 또는 비밀번호가 올바르지 않습니다."));
        reply.header("set-cookie", sessionCookie(token, config));
        request.log.info({ event: "auth.login_succeeded" }, "Login succeeded");
        return { authenticated: true, user: { id: rows[0].user_id, loginId: id } };
      }
      const code = body.inviteCode;
      if (typeof code !== "string" || !/^[\w-]{43}$/.test(code)) return reply.code(400).send(error("INVITE_INVALID", "사용할 수 없는 초대 코드입니다."));
      const available = await sql`SELECT token_hash FROM auth_invites WHERE token_hash = ${tokenHash(code)} AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`;
      if (!available.length) return reply.code(400).send(error("INVITE_INVALID", "사용할 수 없는 초대 코드입니다."));
      const passwordHash = await hashPassword(password);
      try {
        const result = await sql.begin(async (tx) => {
          const invite = await tx`UPDATE auth_invites SET used_at = now() WHERE token_hash = ${tokenHash(code)} AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING token_hash`;
          if (!invite.length) return null;
          const users = await tx<{ id: string }[]>`INSERT INTO users (display_name) VALUES (${id}) RETURNING id`;
          await tx`INSERT INTO auth_credentials (user_id, login_id, password_hash) VALUES (${users[0].id}, ${id}, ${passwordHash})`;
          const token = await issueSession(tx, users[0].id, sessionToken(request.headers.cookie));
          return { token, user: { id: users[0].id, loginId: id } };
        });
        if (!result) return reply.code(400).send(error("INVITE_INVALID", "사용할 수 없는 초대 코드입니다."));
        reply.header("set-cookie", sessionCookie(result.token, config));
        return reply.code(201).send({ authenticated: true, user: result.user });
      } catch (cause) {
        if ((cause as { code?: string }).code === "23505") return reply.code(409).send(error("LOGIN_ID_TAKEN", "이미 사용 중인 아이디입니다."));
        throw cause;
      }
    });
  }
  app.post("/auth/logout", async (request, reply) => {
    const token = sessionToken(request.headers.cookie);
    if (token && sql) await revokeSession(sql, token);
    reply.header("set-cookie", sessionCookie("", config));
    return { authenticated: false, user: null };
  });
}
function error(code: string, message: string) { return { error: { code, message } }; }
