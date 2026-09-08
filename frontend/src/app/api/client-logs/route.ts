import { serverLog } from "@/lib/server-log";
import { BodyTooLarge, readLimitedBody } from "@/lib/read-limited-body";
import { safeFields, type Level } from "@/lib/log-fields";

export const runtime = "nodejs";
let count = 0;
let windowStart = 0;

export async function POST(request: Request) {
  // This public endpoint contains untrusted browser reports, not authoritative server events.
  if (request.headers.get("sec-fetch-site") === "cross-site") return new Response(null, { status: 403 });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return new Response(null, { status: 415 });
  // ponytail: per-process cap; use an ingress limit if the frontend is scaled across replicas.
  if (Date.now() - windowStart > 60_000) { count = 0; windowStart = Date.now(); }
  if (++count > 300) return new Response(null, { status: 429 });
  try {
    const data: unknown = JSON.parse(new TextDecoder().decode(await readLimitedBody(request, 16_384)));
    if (!Array.isArray(data) || data.length > 20) return new Response(null, { status: 400 });
    for (const item of data) {
      if (!item || typeof item !== "object" || !["info", "warn", "error"].includes(item.level)
        || typeof item.event !== "string" || !/^[a-z][a-z0-9_.]{0,79}$/.test(item.event)) continue;
      serverLog(item.level as Level, `browser.${item.event}`, safeFields(item));
    }
    return new Response(null, { status: 204 });
  } catch (error) { return new Response(null, { status: error instanceof BodyTooLarge ? 413 : 400 }); }
}
