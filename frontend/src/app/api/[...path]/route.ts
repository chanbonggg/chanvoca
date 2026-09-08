import { errorFields, routeName } from "@/lib/log-fields";
import { serverLog } from "@/lib/server-log";
import { BodyTooLarge, readLimitedBody } from "@/lib/read-limited-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function forward(request: Request) {
  const frontendRequestId = crypto.randomUUID();
  const clientRequestId = request.headers.get("x-client-request-id");
  const url = new URL(request.url);
  const fields = { frontendRequestId, clientRequestId, route: routeName(url.pathname), method: request.method };
  const started = performance.now();
  let stage = "proxy.read_body";
  serverLog("info", "proxy.started", fields);
  try {
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : await readLimitedBody(request, 11 * 1024 * 1024);
    serverLog("debug", "proxy.body_received", { ...fields, bytes: body?.byteLength ?? 0 });
    stage = "proxy.connect_backend";
    const base = new URL(process.env.BACKEND_INTERNAL_URL ?? "http://localhost:4000");
    const target = new URL(base);
    target.pathname = url.pathname;
    target.search = url.search;
    const headers = new Headers();
    for (const name of ["content-type", "accept", "authorization", "cookie", "user-agent"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const response = await fetch(target, { method: request.method, headers, body, redirect: "manual", cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]) });
    const backendRequestId = response.headers.get("x-request-id");
    serverLog(response.ok ? "info" : "warn", "proxy.response", { ...fields, backendRequestId, statusCode: response.status, durationMs: performance.now() - started });
    stage = "proxy.read_response";
    // Current APIs return bounded JSON, not SSE. Finish reading before claiming completion.
    const result = await response.arrayBuffer();
    const responseHeaders = new Headers();
    for (const name of ["content-type", "x-request-id", "retry-after", "location", "allow"]) {
      const value = response.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set("x-frontend-request-id", frontendRequestId);
    responseHeaders.set("cache-control", "no-store");
    serverLog(response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info", "proxy.completed", { ...fields, backendRequestId, statusCode: response.status, bytes: result.byteLength, durationMs: performance.now() - started });
    return new Response(request.method === "HEAD" || [204, 205, 304].includes(response.status) ? null : result, { status: response.status, headers: responseHeaders });
  } catch (error) {
    const statusCode = error instanceof BodyTooLarge ? 413 : error instanceof Error && error.name === "TimeoutError" ? 504 : request.signal.aborted ? 499 : 502;
    const errorCode = statusCode === 413 ? "FILE_TOO_LARGE" : statusCode === 504 ? "BACKEND_TIMEOUT" : statusCode === 499 ? "CLIENT_ABORTED" : "BACKEND_UNAVAILABLE";
    serverLog(statusCode >= 500 ? "error" : "warn", "proxy.failed", { ...fields, ...errorFields(error), errorCode, stage, statusCode, durationMs: performance.now() - started });
    return Response.json({ error: { code: errorCode, message: statusCode === 413 ? "파일은 최대 10 MiB까지 업로드할 수 있습니다." : "서버 요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요." } }, { status: statusCode, headers: { "x-frontend-request-id": frontendRequestId } });
  }
}

export { forward as GET, forward as POST, forward as PUT, forward as DELETE, forward as PATCH, forward as HEAD, forward as OPTIONS };
