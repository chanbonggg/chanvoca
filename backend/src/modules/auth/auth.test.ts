import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, loginId, passwordMatches, validPassword, sessionToken, loadAuthConfig, sessionCookie } from "./auth.js";
import { testConfig, testDatabaseUrl } from "../../test-support.js";
test("normalizes IDs and validates Unicode password boundaries without trimming", () => {
  assert.equal(loginId(" AbC_1 "), "abc_1");
  for (const value of ["ab", "a".repeat(33), "a/b", [], 123]) assert.equal(loginId(value), null);
  for (const length of [15, 128]) assert.equal(validPassword("😀".repeat(length)), true);
  for (const length of [14, 129]) assert.equal(validPassword("한".repeat(length)), false);
  assert.equal(validPassword(" ".repeat(15)), true);
  assert.equal(sessionToken("chanvoca_session=old.signed"), null);
  assert.equal(sessionToken("chanvoca_session=" + "a".repeat(43)), "a".repeat(43));
  assert.match(sessionCookie("", testConfig), /Max-Age=0/);
  assert.throws(() => testDatabaseUrl("postgres://localhost/chanvoca"));
  assert.throws(() => testDatabaseUrl("postgres://remote/app_test"));
});
test("real scrypt uses distinct salts and rejects invalid passwords and stored formats", async () => {
  const password = "가나다라마바사 😀 password";
  const one = await hashPassword(password), two = await hashPassword(password);
  assert.notEqual(one, two);
  assert.equal(await passwordMatches(password, one), true);
  assert.equal(await passwordMatches(password + "x", one), false);
  await assert.rejects(passwordMatches(password, "broken"));
});
test("invalid application origins and card limits fail closed", (t) => {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  process.env.APP_ORIGIN = "https://example.test";
  process.env.MAX_DAILY_CARDS = "5";
  assert.equal(loadAuthConfig().maxDailyCards, 5);
  process.env.APP_ORIGIN = "https://example.test/path";
  assert.throws(loadAuthConfig);
  process.env.APP_ORIGIN = "https://example.test";
  process.env.MAX_DAILY_CARDS = "0";
  assert.throws(loadAuthConfig);
});


test("scrypt concurrency is bounded instead of exhausting server memory", async () => {
  const pending = [hashPassword("password-one-12345"), hashPassword("password-two-12345")];
  await assert.rejects(hashPassword("password-three-12345"), { statusCode: 503 });
  await Promise.all(pending);
});

test("test DB guards reject URL overrides and loopback aliases of the app DB", (t) => {
  const previous = process.env.DATABASE_URL;
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  process.env.DATABASE_URL = "postgres://localhost:55439/private_test";
  assert.throws(() => testDatabaseUrl("postgres://127.0.0.1:55439/private_test"));
  assert.throws(() => testDatabaseUrl("postgres://localhost/isolated_test?host=remote"));
  assert.throws(() => testDatabaseUrl("http://localhost/isolated_test"));
  assert.equal(testDatabaseUrl("postgres://localhost:55439/isolated_test"), "postgres://localhost:55439/isolated_test");
});
