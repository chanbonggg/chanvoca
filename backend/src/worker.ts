import { randomUUID } from "node:crypto";
import { processExampleJob, markExampleFailed } from "./modules/examples/examples.worker.js";
import { processPushJob, scheduleNotifications } from "./modules/notifications/notifications.worker.js";
import { createDatabase } from "./shared/db.js";
import { claimJobs, completeJob, failJob, recoverStaleJobs } from "./shared/jobs.js";
import { createLogger, logContext, setStage } from "./shared/logger.js";

const log = createLogger("worker").child({ workerId: `worker-${process.pid}` });
let sql: ReturnType<typeof createDatabase>;
let stopping = false;
let activeTick: Promise<void> | undefined;
let intervalId: ReturnType<typeof setInterval> | undefined;

async function tick() {
  await logContext.run({ log: log.child({ tickId: randomUUID() }) }, async () => {
    try {
      setStage("worker.recover_stale_jobs");
      await recoverStaleJobs(sql);
      setStage("worker.schedule_notifications");
      await scheduleNotifications(sql);
      setStage("worker.claim_jobs");
      const jobs = await claimJobs(sql, `worker-${process.pid}`, ["generate_example", "send_push"]);
      if (jobs.length) log.info({ event: "jobs.claimed", count: jobs.length }, "Jobs claimed");
      await Promise.all(jobs.map(async (job) => {
        const payload = job.payload as { traceId?: unknown } | null;
        const traceId = typeof payload?.traceId === "string" && /^[0-9a-f-]{36}$/i.test(payload.traceId) ? payload.traceId : undefined;
        const jobLog = log.child({ jobId: job.id, kind: job.kind, attempt: job.attempts, maxAttempts: job.max_attempts, traceId });
        await logContext.run({ log: jobLog }, async () => {
          const started = performance.now();
          jobLog.info({ event: "job.started" }, "Job started");
          try {
            setStage(`worker.process.${job.kind}`);
            const result = job.kind === "generate_example"
              ? await processExampleJob(sql, job)
              : await processPushJob(sql, job.payload);
            if (result.completed) {
              setStage("worker.complete_job");
              await completeJob(sql, job.id);
              jobLog.info({ event: "job.completed", durationMs: performance.now() - started }, "Job completed");
              return;
            }
            setStage("worker.fail_job");
            const willRetry = await failJob(sql, job, result.error.code, result.error.retryable);
            if (!willRetry && "cardId" in result) await markExampleFailed(sql, result.cardId, result.error.code);
            jobLog[willRetry ? "warn" : "error"]({ event: "job.failed", errorCode: result.error.code, willRetry, durationMs: performance.now() - started }, "Job failed");
          } catch (err) {
            jobLog.error({ event: "job.unexpected_error", stage: logContext.getStore()?.stage, err, durationMs: performance.now() - started, recovery: "stale_job_after_15_minutes" }, "Unexpected job failure; lock retained for stale recovery");
          }
        });
      }));
    } catch (err) {
      log.error({ event: "worker.tick_failed", stage: logContext.getStore()?.stage, err }, "Worker tick failed");
    }
  });
}

function startTick() {
  if (activeTick || stopping) return;
  activeTick = tick().finally(() => { activeTick = undefined; });
}

async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  if (intervalId) clearInterval(intervalId);
  log.info({ event: "worker.stopping", signal }, "Worker stopping");
  try {
    await activeTick;
    await sql.end({ timeout: 5 });
    log.info({ event: "worker.stopped" }, "Worker stopped");
  } catch (err) {
    log.error({ event: "worker.shutdown_failed", err }, "Worker shutdown failed");
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
try {
  sql = createDatabase();
  log.info({ event: "worker.started", pollIntervalMs: 2000 }, "Worker started");
  startTick();
  intervalId = setInterval(startTick, 2_000);
} catch (err) {
  log.fatal({ event: "worker.startup_failed", err }, "Worker startup failed");
  process.exitCode = 1;
}
