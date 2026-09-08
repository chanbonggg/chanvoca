import { AsyncLocalStorage } from "node:async_hooks";
import { pino, type DestinationStream } from "pino";

// Only allow diagnostic metadata. Driver errors can contain SQL values and push keys.
export function serializeError(error: unknown) {
  if (!(error instanceof Error)) return { type: typeof error, message: "Non-Error thrown" };
  const metadata = error as Error & { code?: string; statusCode?: number; cause?: unknown };
  return {
    type: error.name,
    code: metadata.code,
    statusCode: metadata.statusCode,
    // Stack frames retain source file/line without the potentially sensitive message.
    stack: error.stack?.split("\n").filter((line) => /^\s+at /.test(line)).join("\n"),
    ...(metadata.cause instanceof Error ? { cause: {
      type: metadata.cause.name,
      stack: metadata.cause.stack?.split("\n").filter((line) => /^\s+at /.test(line)).join("\n"),
    } } : {}),
  };
}

export function createLogger(component: string, stream?: DestinationStream) {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { service: "chanvoca", component, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: serializeError,
      req: (request) => ({ method: request.method, route: request.routeOptions?.url }),
      res: (reply) => ({ statusCode: reply.statusCode }),
    },
    redact: ["authorization", "cookie", "password", "apiKey", "endpoint", "keys", "body", "payload", "parameters"],
  }, stream);
}

export const logger = createLogger("backend");
export const logContext = new AsyncLocalStorage<{ log: ReturnType<typeof createLogger>; stage?: string }>();
export function currentLog() { return logContext.getStore()?.log ?? logger; }
export function setStage(stage: string) {
  const context = logContext.getStore();
  if (context) context.stage = stage;
  currentLog().debug({ event: "operation.stage", stage }, "Operation stage");
}
