import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../app.js";
import { createLogger, currentLog, setStage, serializeError, logContext } from "./logger.js";
import type { Database } from "./db.js";
import { processPushJob } from "../modules/notifications/notifications.worker.js";
import webpush from "web-push";

test("request context survives awaits, stays isolated, and excludes sensitive request data", async () => {
  const lines: string[] = [];
  const log = createLogger("test", { write: (line) => { lines.push(line); } });
  log.level = "debug";
  const app = buildApp(undefined, log);
  app.post<{ Params: { id: string } }>("/probe/:id", async (request) => {
    setStage(`probe.${request.params.id}`);
    await new Promise((resolve) => setTimeout(resolve, request.params.id === "one" ? 10 : 1));
    currentLog().info({ event: "probe" }, "Probe");
    if (request.params.id === "one") throw new Error("secret-error-value");
    return { ok: true };
  });
  try {
    const responses = await Promise.all(["one", "two"].map((id) => app.inject({
      method: "POST", url: `/probe/${id}?token=secret-query`,
      headers: { authorization: "Bearer secret-auth", cookie: "secret-cookie", "x-request-id": "spoofed" },
      payload: { password: "secret-body" },
    })));
    assert.deepEqual(responses.map((response) => response.statusCode), [500, 200]);
    const ids = responses.map((response) => response.headers["x-request-id"]);
    assert.notEqual(ids[0], ids[1]);
    const records = lines.map((line) => JSON.parse(line));
    for (const reqId of ids) {
      assert.equal(records.filter((record) => record.reqId === reqId && record.event === "probe").length, 1);
      assert.equal(records.filter((record) => record.reqId === reqId && record.event === "http.completed").length, 1);
    }
    const failure = records.find((record) => record.event === "http.error");
    assert.equal(failure.reqId, ids[0]);
    assert.equal(failure.stage, "probe.one");
    assert.match(failure.err.stack, /logger.test.ts:\d+/);
    assert.doesNotMatch(lines.join(""), /secret-|spoofed/);
  } finally { await app.close(); }
});

test("handled readiness failures and application rejections are logged", async () => {
  const lines: string[] = [];
  const log = createLogger("test", { write: (line) => { lines.push(line); } });
  const sql = Object.assign(async () => { throw Object.assign(new Error("secret-db-value"), { code: "08006" }); }, { end: async () => {} }) as unknown as Database;
  const app = buildApp(sql, log);
  try {
    assert.equal((await app.inject("/api/ready")).statusCode, 503);
    assert.equal((await app.inject({ method: "POST", url: "/api/push/subscriptions", payload: {} })).statusCode, 400);
    const records = lines.map((line) => JSON.parse(line));
    assert.equal(records.find((record) => record.event === "health.database_failed").err.code, "08006");
    assert.ok(records.some((record) => record.event === "http.rejected" && record.errorCode === "INVALID_PUSH_SUBSCRIPTION"));
    assert.doesNotMatch(lines.join(""), /secret-db-value/);
  } finally { await app.close(); }
});

test("driver error properties and messages never leak into diagnostics", () => {
  const err = Object.assign(new Error("secret-message", { cause: new Error("secret-cause") }), {
    code: "23514", detail: "secret-detail", query: "secret-query", parameters: ["secret-param"], endpoint: "secret-endpoint",
    schema_name: "public", table_name: "cards", column_name: "source_row", constraint_name: "cards_source_row_check",
  });
  const serialized = serializeError(err);
  assert.ok("code" in serialized && "stack" in serialized);
  assert.equal(serialized.code, "23514");
  assert.equal(serialized.table, "cards");
  assert.equal(serialized.column, "source_row");
  assert.equal(serialized.constraint, "cards_source_row_check");
  assert.match(serialized.stack!, /logger.test.ts/);
  assert.doesNotMatch(JSON.stringify(serialized), /secret-/);
});

test("push provider failures retain job context, source stack, and disable expired subscriptions", async (t) => {
  const lines: string[] = [];
  const log = createLogger("test", { write: (line) => { lines.push(line); } }).child({ jobId: "test-job", traceId: "test-trace" });
  const previous = ["VAPID_SUBJECT", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"].map((key) => [key, process.env[key]] as const);
  for (const [key] of previous) process.env[key] = "secret-vapid";
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  t.mock.method(webpush, "setVapidDetails", () => {});
  t.mock.method(webpush, "sendNotification", async () => { throw Object.assign(new Error("secret-provider-body"), { statusCode: 410 }); });
  let calls = 0;
  const sql = (async () => {
    calls++;
    return calls === 1 ? [{ id: "subscription", endpoint: "secret-endpoint", p256dh: "secret-key", auth: "secret-auth" }] : [];
  }) as unknown as Database;
  const result = await logContext.run({ log }, () => processPushJob(sql, { subscriptionId: "subscription", title: "secret-title", body: "secret-body", url: "/" }));
  assert.equal(result.completed, false);
  if (!result.completed) {
    assert.equal(result.error.code, "PUSH_HTTP_410");
    assert.equal(result.error.retryable, false);
  }
  assert.equal(calls, 2);
  const failure = lines.map((line) => JSON.parse(line)).find((record) => record.event === "push.failed");
  assert.equal(failure.stage, "push.send");
  assert.equal(failure.jobId, "test-job");
  assert.equal(failure.traceId, "test-trace");
  assert.match(failure.err.stack, /logger.test.ts/);
  assert.doesNotMatch(lines.join(""), /secret-/);
});
