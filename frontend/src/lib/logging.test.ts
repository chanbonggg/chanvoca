import { flushLogs } from "./client-log";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { POST as forward } from "../app/api/[...path]/route";
import { POST as receiveLogs } from "../app/api/client-logs/route";
import { api, ApiError, messageFrom, setApiUser } from "./api";
import { safeFields, errorFields } from "./log-fields";
import { BodyTooLarge, readLimitedBody } from "./read-limited-body";

test("multipart proxy preserves bytes and connects browser, frontend and backend IDs", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  const backendId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  let received = "";
  const server = createServer(async (request, response) => {
    for await (const chunk of request) received += chunk.toString();
    assert.match(request.headers["content-type"]!, /multipart\/form-data; boundary=/);
    response.writeHead(201, { "content-type": "application/json", "x-request-id": backendId, "set-cookie": "chanvoca_session=signed-value; HttpOnly" });
    response.end(JSON.stringify({ day: { id: "saved" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const old = process.env.BACKEND_INTERNAL_URL;
  const address = server.address() as { port: number };
  process.env.BACKEND_INTERNAL_URL = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    if (old === undefined) delete process.env.BACKEND_INTERNAL_URL; else process.env.BACKEND_INTERNAL_URL = old;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const form = new FormData();
  form.set("file", new Blob(["secret-word,secret-meaning"]), "secret-filename.csv");
  const response = await forward(new Request("http://frontend/api/days/upload?token=secret-query", { method: "POST", body: form, headers: { "x-client-request-id": clientId } }));
  assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-request-id"), backendId);
    assert.equal(response.headers.get("set-cookie"), "chanvoca_session=signed-value; HttpOnly");
  assert.match(received, /secret-word,secret-meaning/);
  const completed = lines.map((line) => JSON.parse(line)).find((line) => line.event === "proxy.completed");
  assert.equal(completed.clientRequestId, clientId);
  assert.equal(completed.backendRequestId, backendId);
  assert.equal(completed.frontendRequestId, response.headers.get("x-frontend-request-id"));
  assert.doesNotMatch(lines.join(""), /secret-/);
});

test("proxy connection failures return a traceable error and preserve cause code", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("secret-host", { cause: Object.assign(new Error("secret-cause"), { code: "ECONNREFUSED" }) }); });
  const response = await forward(new Request("http://frontend/api/days/upload", { method: "POST", body: "test" }));
  assert.equal(response.status, 502);
  const failure = lines.map((line) => JSON.parse(line)).find((line) => line.event === "proxy.failed");
  assert.equal(failure.stage, "proxy.connect_backend");
  // Business error code identifies the response; exception details still retain file locations.
  assert.equal(failure.errorCode, "BACKEND_UNAVAILABLE");
  assert.equal(failure.causeCode, "ECONNREFUSED");
  assert.match(failure.stack, /logging.test.ts/);
  assert.equal(errorFields(new Error("hidden", { cause: { code: "ECONNREFUSED" } })).errorCode, "ECONNREFUSED");
  assert.doesNotMatch(lines.join(""), /secret-/);
});

test("HTML errors retain HTTP status and trace IDs instead of hiding behind generic upload failures", async (t) => {
  const frontendId = crypto.randomUUID();
  t.mock.method(globalThis, "fetch", async () => new Response("<html>secret-response</html>", { status: 413, headers: { "x-frontend-request-id": frontendId } }));
  await assert.rejects(api("/api/days/upload", { method: "POST", body: new FormData() }), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.statusCode, 413);
    assert.match(messageFrom(error), new RegExp(frontendId));
    assert.doesNotMatch(messageFrom(error), /secret-response/);
    return true;
  });
});

test("browser collector rejects oversized bodies and ignores sensitive properties", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  const response = await receiveLogs(new Request("http://frontend/api/client-logs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ level: "error", event: "upload.failed", password: "secret-password", message: "secret-message", statusCode: 413, stack: "Error: secret-message\n at run (https://secret-host/chunk.js:12:34)" }]) }));
  assert.equal(response.status, 204);
  assert.match(lines[0], /chunk.js:12:34/);
  assert.doesNotMatch(lines.join(""), /secret-/);
  assert.equal((await receiveLogs(new Request("http://frontend/api/client-logs", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(16_385) }))).status, 413);
  assert.equal((await receiveLogs(new Request("http://frontend/api/client-logs", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }))).status, 403);
  await assert.rejects(readLimitedBody(new Request("http://frontend", { method: "POST", body: "12345" }), 4), BodyTooLarge);
  assert.deepEqual(safeFields({ body: "hidden", route: "/api/study/sessions/private-id?token=hidden" }), { route: "/api/study/sessions/:sessionId" });
});

test("service worker reports notification failures without exposing notification contents", async () => {
  const handlers: Record<string, (event: Record<string, unknown>) => void> = {};
  const reports: string[] = [];
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    Error, URL, AbortSignal, console: { log: () => {} },
    fetch: async (_url: string, init: { body: string }) => { reports.push(init.body); },
    self: {
      addEventListener: (name: string, handler: typeof handlers[string]) => { handlers[name] = handler; },
      registration: { showNotification: async () => { throw new Error("secret-provider-error"); } },
    },
  });
  let pending: Promise<void> | undefined;
  handlers.push({ data: { json: () => ({ title: "secret-title", body: "secret-body" }) }, waitUntil: (promise: Promise<void>) => { pending = promise; } });
  assert.ok(pending);
  await assert.rejects(pending);
  assert.match(reports.join(""), /pwa.notification_failed/);
  assert.doesNotMatch(reports.join(""), /secret-/);
});


test("late responses from a previous account cannot overwrite or sign out the new account", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
  let notifications = 0;
  events.addEventListener("chanvoca:auth-required", () => notifications++);
  let finish!: (response: Response) => void;
  let captured: Headers | undefined;
  let delayed = true;
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (url === "/api/client-logs") return new Response(null, { status: 204 });
    captured = new Headers(init?.headers);
    return delayed ? new Promise<Response>((resolve) => { finish = resolve; }) : Response.json({ days: [] });
  });
  t.after(() => { flushLogs(); if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); setApiUser(null); });
  setApiUser("account-a");
  const pending = api("/api/days");
  assert.equal(captured?.get("x-chanvoca-user"), "account-a");
  setApiUser("account-b");
  finish(Response.json({ error: { code: "AUTH_REQUIRED", message: "expired" } }, { status: 401 }));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(notifications, 0);
  delayed = false;
  await api("/api/days");
  assert.equal(captured?.get("x-chanvoca-user"), "account-b");
});

test("protected API expiry requests authentication but a wrong login does not", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
  let notifications = 0;
  events.addEventListener("chanvoca:auth-required", () => notifications++);
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL) => url === "/api/client-logs" ? new Response(null, { status: 204 }) : Response.json({ error: { code: "AUTH_REQUIRED", message: "expired" } }, { status: 401 }));
  t.after(() => { flushLogs(); if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); setApiUser(null); });
  setApiUser("account-a");
  await assert.rejects(api("/api/days"), ApiError);
  assert.equal(notifications, 1);
  await assert.rejects(api("/api/auth/login", { method: "POST", body: "{}" }), ApiError);
  assert.equal(notifications, 1);
  await assert.rejects(api("/api/auth/invites", { method: "POST" }), ApiError);
  assert.equal(notifications, 2);
});
