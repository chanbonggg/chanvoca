import { buildApp } from "./app.js";
import { createDatabase } from "./shared/db.js";
import { createLogger } from "./shared/logger.js";

const log = createLogger("api");
let app: ReturnType<typeof buildApp> | undefined;
let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ event: "server.stopping", signal }, "Server stopping");
  try {
    await app?.close();
    log.info({ event: "server.stopped" }, "Server stopped");
  } catch (err) {
    log.error({ event: "server.shutdown_failed", err }, "Server shutdown failed");
    process.exitCode = 1;
  }
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
try {
  app = buildApp(createDatabase(), log);
  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ host: "0.0.0.0", port });
  log.info({ event: "server.started", port }, "Server started");
} catch (err) {
  log.fatal({ event: "server.startup_failed", err }, "Server startup failed");
  await app?.close();
  process.exitCode = 1;
}
