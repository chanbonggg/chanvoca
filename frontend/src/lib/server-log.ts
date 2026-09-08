import { levels, safeFields, type Fields, type Level } from "./log-fields";

export function serverLog(level: Level, event: string, fields: Fields = {}) {
  const threshold = process.env.LOG_LEVEL ?? "info";
  if (threshold === "silent" || levels[level] < (levels[threshold as Level] ?? 30)) return;
  console.log(JSON.stringify({ level: levels[level], time: new Date().toISOString(), service: "chanvoca", component: "frontend", event, ...safeFields(fields) }));
}
