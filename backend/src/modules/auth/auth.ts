import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Queryable } from "../../shared/db.js";

export type AuthConfig = { origin: string; secureCookie: boolean; maxDailyCards: number };
export type AuthUser = { id: string; loginId: string; authSessionId: string };
declare module "fastify" { interface FastifyRequest { user: AuthUser | null } }
const cookieName = "chanvoca_session";
const sessionSeconds = 60 * 60 * 24 * 30;
const scryptOptions = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

export function loadAuthConfig(): AuthConfig {
  const origin = process.env.APP_ORIGIN ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000");
  const url = new URL(origin);
  if (url.origin !== origin || !["http:", "https:"].includes(url.protocol) || (process.env.NODE_ENV === "production" && url.protocol !== "https:")) throw new Error("APP_ORIGIN must be an exact HTTP origin (HTTPS in production).");
  const maxDailyCards = Number(process.env.MAX_DAILY_CARDS ?? 5000);
  if (!Number.isSafeInteger(maxDailyCards) || maxDailyCards < 1) throw new Error("MAX_DAILY_CARDS must be a positive integer.");
  return { origin, secureCookie: process.env.NODE_ENV === "production", maxDailyCards };
}
export function loginId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9_]{3,32}$/.test(normalized) ? normalized : null;
}
export function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && [...value].length >= 6 && [...value].length <= 128;
}
// Bound scrypt memory even when many distinct accounts authenticate at once.
let activeHashes = 0;
async function derive(password: string, salt: Buffer) {
  if (activeHashes >= 2) throw Object.assign(new Error("Authentication busy."), { statusCode: 503 });
  activeHashes++;
  try { return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, scryptOptions, (err, key) => err ? reject(err) : resolve(key))); }
  finally { activeHashes--; }
}
export async function hashPassword(password: string) {
  if (!validPassword(password)) throw new Error("Password must contain 6–128 characters.");
  const salt = randomBytes(16);
  return `scrypt:131072:8:1:${salt.toString("hex")}:${(await derive(password, salt)).toString("hex")}`;
}
export async function passwordMatches(password: string, stored: string) {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts.slice(0, 4).join(":") !== "scrypt:131072:8:1" || !/^[a-f0-9]{32}$/.test(parts[4]) || !/^[a-f0-9]{128}$/.test(parts[5])) throw new Error("Invalid stored password hash.");
  return timingSafeEqual(await derive(password, Buffer.from(parts[4], "hex")), Buffer.from(parts[5], "hex"));
}
let dummyHash: Promise<string> | undefined;
export function missingPasswordHash() { return dummyHash ??= hashPassword(randomBytes(32).toString("hex")); }
export function tokenHash(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function newToken() { return randomBytes(32).toString("base64url"); }
export function sessionToken(header?: string) {
  const value = header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return value && /^[\w-]{43}$/.test(value) ? value : null;
}
export function sessionCookie(token: string, config: AuthConfig) {
  return `${cookieName}=${token}; Path=/; Max-Age=${token ? sessionSeconds : 0}; HttpOnly; SameSite=Lax${config.secureCookie ? "; Secure" : ""}`;
}
export async function authenticatedUser(sql: Queryable, token: string): Promise<AuthUser | null> {
  const rows = await sql<{ id: string; login_id: string; auth_session_id: string }[]>`
    SELECT c.user_id AS id, c.login_id, s.id AS auth_session_id
    FROM auth_sessions s JOIN auth_credentials c ON c.user_id = s.user_id
    WHERE s.token_hash = ${tokenHash(token)} AND s.revoked_at IS NULL AND s.expires_at > now()
  `;
  return rows[0] ? { id: rows[0].id, loginId: rows[0].login_id, authSessionId: rows[0].auth_session_id } : null;
}
export function requestUser(request: FastifyRequest) {
  if (!request.user) throw new Error("Authenticated user missing.");
  return request.user;
}
export async function revokeSession(sql: Queryable, token: string) {
  await sql`UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = ${tokenHash(token)} AND revoked_at IS NULL`;
}
export async function issueSession(sql: Queryable, userId: string, previous?: string | null) {
  if (previous) await revokeSession(sql, previous);
  const token = newToken();
  await sql`INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (${tokenHash(token)}, ${userId}, now() + interval '30 days')`;
  return token;
}
export async function consumeRateLimit(sql: Queryable, key: string, limit: number, seconds: number) {
  const rows = await sql<{ attempts: number; retry: number }[]>`
    INSERT INTO auth_rate_limits (key, attempts, expires_at) VALUES (${tokenHash(key)}, 1, now() + ${seconds} * interval '1 second')
    ON CONFLICT (key) DO UPDATE SET
      attempts = CASE WHEN auth_rate_limits.expires_at <= now() THEN 1 ELSE auth_rate_limits.attempts + 1 END,
      expires_at = CASE WHEN auth_rate_limits.expires_at <= now() THEN EXCLUDED.expires_at ELSE auth_rate_limits.expires_at END
    RETURNING attempts, greatest(1, ceil(extract(epoch FROM expires_at - now())))::int AS retry
  `;
  return rows[0].attempts > limit ? rows[0].retry : 0;
}
export async function setupOwner(sql: Queryable, id: string, passwordHash: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtext('auth:setup'))`;
  const users = await sql<{ id: string; display_name: string }[]>`SELECT id, display_name FROM users`;
  const owner = users.find((user) => user.display_name === "owner");
  if (!owner && users.length) throw new Error("Existing database has no unambiguous owner. Setup stopped.");
  const userId = owner?.id ?? (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('owner') RETURNING id`)[0].id;
  await sql`INSERT INTO auth_credentials (user_id, login_id, password_hash) VALUES (${userId}, ${id}, ${passwordHash})`;
  return userId;
}
export async function createInvite(sql: Queryable) {
  const code = newToken();
  await sql`INSERT INTO auth_invites (token_hash, expires_at) VALUES (${tokenHash(code)}, now() + interval '7 days')`;
  return code;
}
export async function cleanAuth(sql: Queryable) {
  await sql`DELETE FROM auth_sessions WHERE id IN (SELECT id FROM auth_sessions WHERE expires_at <= now() OR revoked_at IS NOT NULL LIMIT 500)`;
  await sql`DELETE FROM auth_invites WHERE token_hash IN (SELECT token_hash FROM auth_invites WHERE expires_at <= now() OR revoked_at IS NOT NULL OR used_at IS NOT NULL LIMIT 500)`;
  await sql`DELETE FROM auth_rate_limits WHERE expires_at <= now() AND key IN (SELECT key FROM auth_rate_limits WHERE expires_at <= now() LIMIT 500)`;
}
