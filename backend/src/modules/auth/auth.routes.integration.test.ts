import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../../app.js";
import { createDatabase } from "../../shared/db.js";
import { applyMigrations } from "../../shared/migrations.js";
import { testConfig, testDatabaseUrl, testHash, testPassword } from "../../test-support.js";
import { cleanAuth, consumeRateLimit, createInvite, issueSession, setupOwner, tokenHash } from "./auth.js";
import { processPushJob } from "../notifications/notifications.worker.js";
import webpush from "web-push";

const databaseUrl = testDatabaseUrl();
test("DB-01/02/03: migration and owner setup preserve legacy data and reject repeated setup", { timeout: 30000 }, async () => {
  const sql = createDatabase(databaseUrl);
  try {
    await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    const legacy = await mkdtemp(join(tmpdir(), "chanvoca-legacy-"));
    for (const name of ["0001_initial.sql", "0002_allow_first_row_cards.sql"]) await copyFile(resolve("db/migrations", name), join(legacy, name));
    await applyMigrations(sql, legacy);
    const [owner] = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('owner') RETURNING id`;
    const [day] = await sql<{ id: string }[]>`INSERT INTO days (user_id,day_number,original_filename,source_format,row_count) VALUES (${owner.id},1,'legacy.csv','csv',1) RETURNING id`;
    const [card] = await sql<{ id: string }[]>`INSERT INTO cards (day_id,source_row,term,meaning) VALUES (${day.id},1,'calm','침착한') RETURNING id`;
    const [session] = await sql<{ id: string }[]>`INSERT INTO study_sessions (user_id,target_day_id,target_day_number,plan_day_numbers,total_cards) VALUES (${owner.id},${day.id},1,ARRAY[1],1) RETURNING id`;
    await sql`INSERT INTO study_session_cards (session_id,card_id,initial_order) VALUES (${session.id},${card.id},1)`;
    await sql`INSERT INTO study_attempts (session_id,card_id,round_number,position,result,response_ms,idempotency_key) VALUES (${session.id},${card.id},1,1,'unknown',100,${randomUUID()})`;
    await sql`INSERT INTO notification_settings (user_id,local_time) VALUES (${owner.id},'12:00')`;
    const tables = ["users", "days", "cards", "study_sessions", "study_session_cards", "study_attempts", "notification_settings"];
    const snapshot = async () => Promise.all(tables.map(async (table) => JSON.stringify(await sql`SELECT * FROM ${sql(table)}`)));
    const before = await snapshot();
    await applyMigrations(sql);
    await applyMigrations(sql);
    await sql.begin(async (tx) => assert.equal(await setupOwner(tx, "owner_login", await testHash()), owner.id));
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(sql.begin(async (tx) => setupOwner(tx, "replacement", await testHash())), { code: "23505" });
    assert.deepEqual(await snapshot(), before);
    assert.equal((await sql`SELECT * FROM auth_credentials`).length, 1);
  } finally { await sql.end(); }
});

test("multi-user authentication, ownership, push isolation, quotas and cleanup", { timeout: 180000 }, async (t) => {
  const sql = createDatabase(databaseUrl);
  await applyMigrations(sql);
  await sql.unsafe("TRUNCATE jobs, users, auth_invites, auth_rate_limits CASCADE");
  const app = buildApp(sql, undefined, { ...testConfig, maxDailyCards: 10 });
  t.after(() => app.close());
  const account = async (id: string) => {
    const [user] = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES (${id}) RETURNING id`;
    await sql`INSERT INTO auth_credentials (user_id, login_id, password_hash) VALUES (${user.id}, ${id}, ${await testHash()})`;
    return { id: user.id, cookie: "chanvoca_session=" + await issueSession(sql, user.id) };
  };
  const a = await account("alice"), b = await account("bobby"), c = await account("empty_user");
  const send = (cookie: string, url: string, payload?: import("fastify").InjectOptions["payload"], method: "GET" | "POST" | "PUT" | "DELETE" = payload === undefined ? "GET" : "POST") => app.inject({ method, url, headers: { cookie, origin: testConfig.origin }, ...(payload === undefined ? {} : { payload }) });
  const upload = (cookie: string, count = 1) => app.inject({
    method: "POST", url: "/api/days/upload",
    headers: { cookie, origin: testConfig.origin, "content-type": "multipart/form-data; boundary=test-boundary" },
    payload: "--test-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"words.csv\"\r\nContent-Type: text/csv\r\n\r\nword,meaning\n" + Array.from({ length: count }, (_, i) => "word" + i + ",뜻\n").join("") + "\r\n--test-boundary--\r\n",
  });
  const [dayA, dayB] = await Promise.all([upload(a.cookie), upload(b.cookie)]);
  assert.equal(dayA.statusCode, 201, dayA.body); assert.equal(dayB.statusCode, 201, dayB.body);
  assert.equal(dayA.json().day.dayNumber, 1); assert.equal(dayB.json().day.dayNumber, 1);
  const startA = await send(a.cookie, "/api/study/sessions", { targetDayId: dayA.json().day.id });
  const startB = await send(b.cookie, "/api/study/sessions", { targetDayId: dayB.json().day.id });
  assert.equal(startA.statusCode, 201, startA.body); assert.equal(startB.statusCode, 201, startB.body);
  const sa = startA.json(), sb = startB.json();
  const attempt = (cardId: string) => ({ idempotencyKey: randomUUID(), cardId, roundNumber: 1, position: 1, result: "known", responseMs: 10, revealedAtMs: 1 });

  await t.test("ISO-01/02/03: A and B cannot read or mutate each other's resources", async () => {
    for (const [actor, target, day] of [[a, sb, dayB.json().day], [b, sa, dayA.json().day]] as const) {
      for (const [url, body] of [
        ["/api/study/sessions", { targetDayId: day.id }],
        ["/api/study/sessions", { repeatOfSessionId: target.session.id }],
        ["/api/study/sessions/" + target.session.id, undefined],
        ["/api/study/sessions/" + target.session.id + "/rounds", {}],
        ["/api/study/sessions/" + target.session.id + "/attempts", attempt(target.cards[0].id)],
        ["/api/study/sessions/" + target.session.id + "/days/" + day.id + "/cards", undefined],
      ] as const) {
        assert.equal((await send(actor.cookie, url, body)).statusCode, 404, url);
      }
    }
    assert.equal((await sql`SELECT * FROM study_attempts`).length, 0);
    assert.equal((await sql`SELECT * FROM study_sessions`).length, 2);
    assert.deepEqual((await send(c.cookie, "/api/days")).json().days, []);
    assert.equal((await send(a.cookie, "/api/days?userId=" + b.id)).json().days[0].id, dayA.json().day.id);
    assert.equal((await send(a.cookie, "/api/study/sessions/" + sa.session.id + "/attempts", attempt(sb.cards[0].id))).statusCode, 409);
    assert.equal((await send(a.cookie, "/api/study/sessions", { targetDayId: ["invalid"] })).statusCode, 400);
    assert.equal((await send(a.cookie, "/api/study/sessions/invalid")).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/study/sessions", headers: { cookie: a.cookie, origin: testConfig.origin, "x-chanvoca-user": b.id }, payload: {} })).statusCode, 409);
  });
  await t.test("ISO-05: concurrent duplicate answers are idempotent", async () => {
    const body = attempt(sa.cards[0].id);
    const responses = await Promise.all([send(a.cookie, "/api/study/sessions/" + sa.session.id + "/attempts", body), send(a.cookie, "/api/study/sessions/" + sa.session.id + "/attempts", body)]);
    assert.deepEqual(responses.map((r) => r.statusCode), [200, 200]);
    assert.equal((await sql`SELECT * FROM study_attempts WHERE session_id = ${sa.session.id}`).length, 1);
    assert.equal((await sql`SELECT known_count FROM study_sessions WHERE id = ${sa.session.id}`)[0].known_count, 1);
  });
  await t.test("AUTH-05/06: one-time invitations remain atomic in 20 concurrent races", async () => {
    for (let i = 0; i < 20; i++) {
      await sql`TRUNCATE auth_rate_limits`;
      const code = await createInvite(sql);
      const results = await Promise.all([0, 1].map((n) => send("", "/api/auth/register", { loginId: "race_" + i + "_" + n, password: testPassword, inviteCode: code })));
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 400]);
    }
    await sql`TRUNCATE auth_rate_limits`;
    const code = await createInvite(sql);
    assert.equal((await send("", "/api/auth/register", { loginId: "alice", password: testPassword, inviteCode: code })).statusCode, 409);
    assert.equal((await sql`SELECT used_at FROM auth_invites WHERE token_hash = ${tokenHash(code)}`)[0].used_at, null);
    assert.equal((await send("", "/api/auth/register", { loginId: "fresh_user", password: testPassword, inviteCode: code })).statusCode, 201);
    const expired = await createInvite(sql);
    await sql`UPDATE auth_invites SET expires_at = now() - interval '1 second' WHERE token_hash = ${tokenHash(expired)}`;
    assert.equal((await send("", "/api/auth/register", { loginId: "expired_user", password: testPassword, inviteCode: expired })).statusCode, 400);
    const cancelled = await createInvite(sql);
    await sql`UPDATE auth_invites SET revoked_at = now() WHERE token_hash = ${tokenHash(cancelled)}`;
    assert.equal((await send("", "/api/auth/register", { loginId: "cancelled_user", password: testPassword, inviteCode: cancelled })).statusCode, 400);
  });
  await t.test("AUTH-03/04/09: login identity, logout, expiry and stale cookies", async () => {
    const wrong = await send("", "/api/auth/login", { loginId: "alice", password: "wrong-password-1234" });
    const missing = await send("", "/api/auth/login", { loginId: "nobody", password: "wrong-password-1234" });
    assert.equal(wrong.statusCode, 401); assert.deepEqual(wrong.json(), missing.json());
    const login = await send("", "/api/auth/login", { loginId: " Alice ", password: testPassword });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    assert.match(String(login.headers["set-cookie"]), /HttpOnly; SameSite=Lax/);
    assert.equal((await send(cookie, "/api/auth/session")).json().user.id, a.id);
    await send(cookie, "/api/auth/logout", {});
    assert.equal((await send(cookie, "/api/days")).statusCode, 401);
    assert.equal((await send(a.cookie, "/api/days")).statusCode, 200);
    const token = await issueSession(sql, a.id);
    await sql`UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = ${tokenHash(token)}`;
    assert.equal((await send("chanvoca_session=" + token, "/api/days")).statusCode, 401);
    assert.equal((await send("chanvoca_session=old.signed", "/api/days")).statusCode, 401);
  });
  await t.test("PUSH-02/03/04/05: session-bound notifications cannot follow account switches", async (st) => {
    const previous = ["VAPID_SUBJECT", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"].map((key) => [key, process.env[key]] as const);
    for (const [key] of previous) process.env[key] = "fake-test-value";
    st.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    st.mock.method(webpush, "setVapidDetails", () => {});
    const provider = st.mock.method(webpush, "sendNotification", async () => ({ statusCode: 201, body: "", headers: {} }));
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/device", keys: { p256dh: "test-key", auth: "test-auth" } };
    assert.equal((await send(a.cookie, "/api/push/subscriptions", sub)).statusCode, 201);
    assert.equal((await send(b.cookie, "/api/push/subscriptions", sub)).statusCode, 409);
    assert.equal((await send(b.cookie, "/api/push/subscriptions", { endpoint: sub.endpoint }, "DELETE")).statusCode, 204);
    assert.equal((await sql`SELECT disabled_at FROM push_subscriptions WHERE endpoint = ${sub.endpoint}`)[0].disabled_at, null);
    await send(a.cookie, "/api/push/test", {});
    const [job] = await sql<{ payload: unknown }[]>`SELECT payload FROM jobs WHERE kind = 'send_push'`;
    await processPushJob(sql, job.payload);
    assert.equal(provider.mock.callCount(), 1);
    await send(a.cookie, "/api/auth/logout", {});
    assert.equal((await send(b.cookie, "/api/push/subscriptions", sub)).statusCode, 201);
    await processPushJob(sql, job.payload);
    await processPushJob(sql, { subscriptionId: randomUUID(), title: "legacy", body: "legacy", url: "/" });
    assert.equal(provider.mock.callCount(), 1);
    const loginA = await send(b.cookie, "/api/auth/login", { loginId: "alice", password: testPassword });
    assert.equal(loginA.statusCode, 200, loginA.body);
    a.cookie = String(loginA.headers["set-cookie"]).split(";")[0];
    assert.equal((await send(a.cookie, "/api/push/subscriptions", sub)).statusCode, 201);
    await processPushJob(sql, job.payload);
    assert.equal(provider.mock.callCount(), 1);
    b.cookie = "chanvoca_session=" + await issueSession(sql, b.id);
  });
  await t.test("QUOTA-01/02/03: concurrent uploads cannot exceed the per-user daily limit", async () => {
    for (let i = 0; i < 20; i++) {
      await sql`UPDATE days SET imported_at = now() - interval '2 days' WHERE user_id = ${a.id}`;
      const before = (await sql`SELECT id FROM jobs`).length;
      const result = await Promise.all([upload(a.cookie, 6), upload(a.cookie, 6)]);
      assert.deepEqual(result.map((r) => r.statusCode).sort(), [201, 429]);
      assert.equal((await sql`SELECT id FROM jobs`).length - before, 6);
      const limited = result.find((r) => r.statusCode === 429)!;
      assert.ok(Number(limited.headers["retry-after"]) > 0);
    }
    assert.equal((await upload(a.cookie, 4)).statusCode, 201);
    assert.equal((await upload(a.cookie, 1)).statusCode, 429);
    assert.equal((await upload(b.cookie, 1)).statusCode, 201);
  });
  await t.test("AUTH-07: independent connections share request limits and reset after expiry", async () => {
    const other = createDatabase(databaseUrl);
    try {
      const result = await Promise.all([consumeRateLimit(sql, "shared", 1, 60), consumeRateLimit(other, "shared", 1, 60)]);
      assert.equal(result.filter((n) => n === 0).length, 1);
      assert.ok(result.some((n) => n > 0));
      await sql`UPDATE auth_rate_limits SET expires_at = now() - interval '1 second' WHERE key = ${tokenHash("shared")}`;
      assert.equal(await consumeRateLimit(other, "shared", 1, 60), 0);
      await sql`TRUNCATE auth_rate_limits`;
      for (let i = 0; i < 61; i++) {
        const r = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: testConfig.origin, "x-forwarded-for": "1.2.3." + i }, payload: {} });
        assert.equal(r.statusCode, i < 60 ? 400 : 429);
      }
    } finally { await other.end(); }
  });
  await t.test("CLEAN-01/02: expired sessions are removed in bounded batches without deleting learning data", async () => {
    const cards = (await sql`SELECT id FROM cards`).length;
    await sql`INSERT INTO auth_rate_limits (key, attempts, expires_at) SELECT 'old-' || n, 1, now() - interval '1 day' FROM generate_series(1,501) n`;
    await cleanAuth(sql);
    assert.equal((await sql`SELECT key FROM auth_rate_limits WHERE key LIKE 'old-%'`).length, 1);
    await cleanAuth(sql);
    assert.equal((await sql`SELECT key FROM auth_rate_limits WHERE key LIKE 'old-%'`).length, 0);
    assert.equal((await sql`SELECT id FROM cards`).length, cards);
    assert.equal((await send(a.cookie, "/api/days")).statusCode, 200);
  });
  await t.test("DB-04/AUTH-09: built-in CLI resets a password and invalidates every existing login", async () => {
    await sql`TRUNCATE auth_rate_limits`;
    const before = (await sql`SELECT id FROM cards`).length;
    const nextPassword = "replacement-password-12345";
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/modules/auth/auth.cli.ts", "reset-password", "alice"], {
      input: nextPassword + "\n", encoding: "utf8", timeout: 30000,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(nextPassword));
    assert.equal((await send(a.cookie, "/api/days")).statusCode, 401);
    assert.equal((await send("", "/api/auth/login", { loginId: "alice", password: testPassword })).statusCode, 401);
    assert.equal((await send("", "/api/auth/login", { loginId: "alice", password: nextPassword })).statusCode, 200);
    assert.equal((await sql`SELECT id FROM cards`).length, before);
  });

});
