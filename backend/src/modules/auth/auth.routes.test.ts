import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../app.js";
import type { AuthConfig } from "./auth.js";

const config: AuthConfig = { password: "test-password-123", sessionSecret: "test-session-secret-that-is-long-enough", secureCookie: true };

test("protects API routes with a signed session cookie and logs login outcomes", async () => {
  const app = buildApp(undefined, undefined, config);
  app.get("/protected", async () => ({ ok: true }));
  try {
    assert.deepEqual((await app.inject("/api/auth/session")).json(), { authenticated: false });
    assert.equal((await app.inject("/protected")).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "wrong-password" } })).statusCode, 401);

    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: config.password } });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers["set-cookie"];
    if (typeof cookie !== "string") assert.fail("Login must set a session cookie.");
    assert.match(cookie, /HttpOnly; SameSite=Lax; Secure/);
    assert.equal((await app.inject({ method: "GET", url: "/protected", headers: { cookie } })).statusCode, 200);

    const logout = await app.inject({ method: "POST", url: "/api/auth/logout" });
    const clearedCookie = logout.headers["set-cookie"];
    if (typeof clearedCookie !== "string") assert.fail("Logout must clear the session cookie.");
    assert.match(clearedCookie, /Max-Age=0/);
  } finally {
    await app.close();
  }
});
