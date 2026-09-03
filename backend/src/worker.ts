import { processExampleJob, markExampleFailed } from "./modules/examples/examples.worker.js";
import { processPushJob, scheduleNotifications } from "./modules/notifications/notifications.worker.js";
import { createDatabase } from "./shared/db.js";
import { claimJobs, completeJob, failJob, recoverStaleJobs } from "./shared/jobs.js";

const sql = createDatabase();
const workerId = `worker-${process.pid}`;
let stopping = false;
let running = false;
let intervalId: ReturnType<typeof setInterval> | undefined;

async function tick() {
  if (running || stopping) return;
  running = true;

  try {
    await recoverStaleJobs(sql);
    await scheduleNotifications(sql);
    const jobs = await claimJobs(sql, workerId, ["generate_example", "send_push"]);
    await Promise.all(jobs.map(async (job) => {
      if (job.kind === "generate_example") {
        const result = await processExampleJob(sql, job);
        if (result.completed) return completeJob(sql, job.id);

        const willRetry = await failJob(sql, job, result.error.code, result.error.retryable);
        if (!willRetry) await markExampleFailed(sql, result.cardId, result.error.code);
        return;
      }

      const result = await processPushJob(sql, job.payload);
      if (result.completed) return completeJob(sql, job.id);
      await failJob(sql, job, result.error.code, result.error.retryable);
    }));
  } catch (error) {
    console.error("Worker tick failed", error);
  } finally {
    running = false;
  }
}

async function stop() {
  stopping = true;
  if (intervalId) clearInterval(intervalId);
  await sql.end();
}

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

await tick();
intervalId = setInterval(() => void tick(), 2_000);
