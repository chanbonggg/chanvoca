import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type AuthConfig = {
  password: string;
  sessionSecret: string;
  secureCookie: boolean;
};

type Session = { exp: number; v: 1 };

const cookieName = "chanvoca_session";
const sessionMaxAgeSeconds = 60 * 60 * 24 * 30;

export function loadAuthConfig(): AuthConfig {
  const password = process.env.APP_PASSWORD;
  const sessionSecret = process.env.APP_SESSION_SECRET;
  if (!password || password.length < 12) throw new Error("APP_PASSWORD must be at least 12 characters.");
  if (!sessionSecret || sessionSecret.length < 32) throw new Error("APP_SESSION_SECRET must be at least 32 characters.");
  return { password, sessionSecret, secureCookie: process.env.NODE_ENV === "production" };
}

export function passwordMatches(password: string, config: AuthConfig) {
  const received = createHash("sha256").update(password).digest();
  const expected = createHash("sha256").update(config.password).digest();
  return timingSafeEqual(received, expected);
}

export function createSessionCookie(config: AuthConfig) {
  const value = signSession({ v: 1, exp: now() + sessionMaxAgeSeconds }, config);
  return `${cookieName}=${value}; Path=/; Max-Age=${sessionMaxAgeSeconds}; HttpOnly; SameSite=Lax${config.secureCookie ? "; Secure" : ""}`;
}

export function clearSessionCookie(config: AuthConfig) {
  return `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${config.secureCookie ? "; Secure" : ""}`;
}

export function sessionStatus(cookieHeader: string | undefined, config: AuthConfig): "valid" | "missing" | "invalid" | "expired" {
  const value = cookieHeader?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!value) return "missing";
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra || !matchesSignature(payload, signature, config)) return "invalid";
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    return session.v === 1 && Number.isInteger(session.exp) ? (session.exp > now() ? "valid" : "expired") : "invalid";
  } catch {
    return "invalid";
  }
}

function signSession(session: Session, config: AuthConfig) {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${signatureFor(payload, config)}`;
}

function matchesSignature(payload: string, received: string, config: AuthConfig) {
  const expected = Buffer.from(signatureFor(payload, config));
  const actual = Buffer.from(received);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function signatureFor(payload: string, config: AuthConfig) {
  return createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

function now() {
  return Math.floor(Date.now() / 1_000);
}
