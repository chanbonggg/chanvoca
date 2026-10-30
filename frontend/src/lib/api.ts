import { clientLog, reportError } from "./client-log";
import { routeName } from "./log-fields";

let activeUser: string | null = null;
let authGeneration = 0;
export function setApiUser(userId: string | null) { activeUser = userId; authGeneration++; }

export class ApiError extends Error {
  constructor(message: string, readonly statusCode: number, readonly errorCode: string,
    readonly clientRequestId: string, readonly frontendRequestId?: string, readonly backendRequestId?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const generation = authGeneration;
  const clientRequestId = crypto.randomUUID();
  const started = performance.now();
  const fields = { clientRequestId, route: routeName(path), method: init?.method ?? "GET" };
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  headers.set("x-client-request-id", clientRequestId);
  if (activeUser && !["/api/auth/login", "/api/auth/register", "/api/auth/session"].includes(path)) headers.set("x-chanvoca-user", activeUser);
  clientLog("info", "api.started", fields, false);
  let stage = "api.fetch";
  try {
    const response = await fetch(path, { ...init, headers });
    const frontendRequestId = response.headers.get("x-frontend-request-id") ?? undefined;
    const backendRequestId = response.headers.get("x-request-id") ?? undefined;
    const responseFields = { ...fields, frontendRequestId, backendRequestId, statusCode: response.status };
    clientLog("debug", "api.response", responseFields, false);
    stage = "api.decode_response";
    const data = response.status === 204 ? null : await response.json().catch(() => null) as { error?: { message?: string; code?: string; rows?: number[] }; message?: string } | null;
    if (generation !== authGeneration) throw new DOMException("Account changed", "AbortError");
    if (!response.ok) {
      if ((response.status === 401 || data?.error?.code === "AUTH_CHANGED") && (!path.startsWith("/api/auth/") || path === "/api/auth/invites")) window.dispatchEvent(new Event("chanvoca:auth-required"));
      const rowText = data?.error?.rows?.length ? ` (오류 행: ${data.error.rows.join(", ")})` : "";
      throw new ApiError(`${data?.error?.message ?? "서버 요청에 실패했습니다."}${rowText}`, response.status,
        data?.error?.code ?? `HTTP_${response.status}`, clientRequestId, frontendRequestId, backendRequestId);
    }
    if (response.status !== 204 && data === null) throw new ApiError("서버 응답을 읽지 못했습니다.", response.status, "INVALID_JSON_RESPONSE", clientRequestId, frontendRequestId, backendRequestId);
    clientLog("info", "api.completed", { ...responseFields, durationMs: performance.now() - started }, false);
    return data as T;
  } catch (error) {
    reportError("api.failed", error, { ...fields, stage, online: navigator.onLine, durationMs: performance.now() - started });
    throw error;
  }
}

export function messageFrom(error: unknown) {
  if (error instanceof ApiError) {
    return `${error.message} (HTTP ${error.statusCode}, 추적 ID: ${error.frontendRequestId ?? error.clientRequestId})`;
  }
  return error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
}
