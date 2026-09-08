import { errorFields, levels, safeFields, type Fields, type Level } from "./log-fields";

const queue: Fields[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let sent = 0;
let windowStart = 0;

export function flushLogs() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (!queue.length) return;
  const batch: Fields[] = [];
  while (queue.length && batch.length < 20 && JSON.stringify([...batch, queue[0]]).length < 14_000) batch.push(queue.shift()!);
  const body = JSON.stringify(batch);
  if (queue.length) timer = setTimeout(flushLogs, 1000);
  // Best effort: never retry or report telemetry failures through telemetry itself.
  try {
    void fetch("/api/client-logs", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  } catch { /* Logging must not break the app. */ }
}

export function clientLog(level: Level, event: string, fields: Fields = {}, report = true) {
  if (typeof window === "undefined") return;
  const entry = { level, event, ...safeFields(fields) };
  if (level !== "debug" || process.env.NEXT_PUBLIC_LOG_LEVEL === "debug") {
    console[level](JSON.stringify({ ...entry, level: levels[level], time: new Date().toISOString(), component: "browser" }));
  }
  if (!report || level === "debug") return;
  if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); sent = 0; }
  if (sent >= (level === "info" ? 80 : 100)) return;
  sent++;
  queue.push(entry);
  if (queue.length >= 20) flushLogs();
  else timer ??= setTimeout(flushLogs, 1000);
}

export function reportError(event: string, error: unknown, fields: Fields = {}) {
  clientLog("error", event, { ...errorFields(error), ...fields });
}
