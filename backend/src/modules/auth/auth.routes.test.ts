import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../../app.js";
import { testConfig } from "../../test-support.js";
test("health is public, missing authentication is denied and Origin is checked before storage", async () => {
  const app = buildApp(undefined, undefined, testConfig);
  app.get("/protected", async () => ({ ok: true }));
  try {
    assert.deepEqual((await app.inject("/api/auth/session")).json(), { authenticated: false, user: null });
    assert.equal((await app.inject("/protected")).statusCode, 401);
    for (const origin of [undefined, "null", "https://evil.test"]) {
      assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", headers: origin ? { origin } : {} })).statusCode, 403);
    }
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: testConfig.origin } })).statusCode, 503);
    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin: testConfig.origin } });
    assert.equal(logout.statusCode, 200);
    assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);
    assert.equal((await app.inject({ method: "GET", url: "/protected", headers: { cookie: "chanvoca_session=old.signed" } })).statusCode, 401);
  } finally { await app.close(); }
});
