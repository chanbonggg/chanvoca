export const levels = { debug: 20, info: 30, warn: 40, error: 50 } as const;
export type Level = keyof typeof levels;
export type Fields = Record<string, unknown>;
const token = /^[a-zA-Z0-9_.:-]{1,100}$/;
const uuid = /^[a-f0-9-]{36}$/i;

export function routeName(path: string) {
  const clean = path.split(/[?#]/)[0];
  if (/^\/api\/study\/sessions\/[^/]+(?:\/(attempts|rounds))?$/.test(clean)) {
    return clean.replace(/(\/sessions\/)[^/]+/, "$1:sessionId");
  }
  return ["/", "/api/days", "/api/days/", "/api/days/upload", "/api/study/sessions", "/api/push/config", "/api/push/subscriptions", "/api/push/test", "/api/notification-settings", "/api/health", "/api/ready"].includes(clean) ? clean : "unmatched";
}

// Project only diagnostic fields; never serialize arbitrary errors, bodies or headers.
export function safeFields(input: Fields): Fields {
  const output: Fields = {};
  for (const key of ["stage", "errorType", "errorCode", "causeCode", "method", "digest", "permission", "format"]) {
    if (typeof input[key] === "string" && token.test(input[key])) output[key] = input[key];
  }
  for (const key of ["clientRequestId", "frontendRequestId", "backendRequestId", "sessionId", "cardId", "dayId"]) {
    if (typeof input[key] === "string" && uuid.test(input[key])) output[key] = input[key];
  }
  for (const key of ["statusCode", "durationMs", "bytes", "rowCount", "roundNumber", "count"]) {
    if (typeof input[key] === "number" && Number.isFinite(input[key]) && input[key] >= 0) output[key] = input[key];
  }
  if (typeof input.route === "string") output.route = routeName(input.route);
  if (typeof input.online === "boolean") output.online = input.online;
  if (typeof input.stack === "string") {
    // Keep file/chunk and line/column only, without URL hosts, query strings or messages.
    output.stack = [...input.stack.slice(0, 8192).matchAll(/([a-zA-Z0-9_.-]+\.(?:[cm]?js|tsx?)):(\d+):(\d+)/g)]
      .slice(0, 10).map((match) => `${match[1].slice(-128)}:${match[2]}:${match[3]}`).join("\n");
  }
  return output;
}

export function errorFields(error: unknown): Fields {
  if (!(error instanceof Error)) return { errorType: "NonError" };
  const details = error as Error & { code?: string; errorCode?: string; digest?: string };
  const cause = error.cause as { code?: string } | undefined;
  return safeFields({ ...error, errorType: error.name, errorCode: details.errorCode ?? details.code ?? cause?.code, causeCode: cause?.code, digest: details.digest, stack: error.stack });
}
