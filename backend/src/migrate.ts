import { createDatabase } from "./shared/db.js";
import { applyMigrations } from "./shared/migrations.js";
import { createLogger, logContext } from "./shared/logger.js";

const log = createLogger("migration");
await logContext.run({ log }, async () => {
  let sql: ReturnType<typeof createDatabase> | undefined;
  try {
    log.info({ event: "migrations.started" }, "Database migrations started");
    sql = createDatabase();
    await applyMigrations(sql);
    log.info({ event: "migrations.completed" }, "Database migrations are up to date");
  } catch (err) {
    log.fatal({ event: "migrations.failed", err }, "Database migrations failed");
    process.exitCode = 1;
  } finally {
    try { await sql?.end({ timeout: 5 }); }
    catch (err) {
      log.error({ event: "migrations.shutdown_failed", err }, "Database shutdown failed");
      process.exitCode = 1;
    }
  }
});
