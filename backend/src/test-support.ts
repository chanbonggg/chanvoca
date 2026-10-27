import assert from "node:assert/strict";
import type { Database } from "./shared/db.js";
import type { buildApp } from "./app.js";
import { hashPassword, setupOwner, type AuthConfig } from "./modules/auth/auth.js";
export const testConfig: AuthConfig = { origin: "http://localhost:3000", secureCookie: false, maxDailyCards: 5000 };
export const testPassword = "test-password-12345";
export function testDatabaseUrl(raw = process.env.TEST_DATABASE_URL) {
  if (!raw) throw new Error("TEST_DATABASE_URL is required; integration tests cannot be skipped.");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.search || !decodeURIComponent(url.pathname).endsWith("_test") || !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Use an isolated local database ending in _test, without URL overrides.");
  if (process.env.DATABASE_URL) {
    const app = new URL(process.env.DATABASE_URL);
    const host = (value: string) => ["localhost", "127.0.0.1", "[::1]"].includes(value) ? "loopback" : value;
    if (host(url.hostname) === host(app.hostname) && (url.port || "5432") === (app.port || "5432") && decodeURIComponent(url.pathname) === decodeURIComponent(app.pathname)) throw new Error("Test database must differ from app database.");
  }
  return raw;
}
let hashed: Promise<string> | undefined;
export function testHash() { return hashed ??= hashPassword(testPassword); }
export async function loginOwner(app: ReturnType<typeof buildApp>, sql: Database) {
  await sql`TRUNCATE auth_rate_limits`;
  await sql.begin(async (tx) => setupOwner(tx, "tester", await testHash()));
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: testConfig.origin }, payload: { loginId: "tester", password: testPassword } });
  assert.equal(login.statusCode, 200, login.body);
  return String(login.headers["set-cookie"]).split(";")[0];
}
