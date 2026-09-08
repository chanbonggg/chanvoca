import type { Database, Queryable } from "./db.js";
import type postgres from "postgres";
import { currentLog } from "./logger.js";

export type JobKind = "generate_example" | "send_push";

export type Job = {
  id: string;
  kind: JobKind;
  payload: unknown;
  attempts: number;
  max_attempts: number;
};

export async function enqueueJob(
  sql: Queryable,
  kind: JobKind,
  dedupeKey: string,
  payload: postgres.JSONValue,
) {
  const traceId = currentLog().bindings().reqId;
  const tracedPayload = payload && typeof payload === "object" && !Array.isArray(payload) && traceId
    ? { ...payload, traceId } : payload;
  const result = await sql`
    INSERT INTO jobs ${sql({ kind, dedupe_key: dedupeKey, payload: sql.json(tracedPayload) })}
    ON CONFLICT (kind, dedupe_key) DO NOTHING
  `;
  currentLog().debug({ event: "job.enqueued", kind, inserted: result.count }, "Job enqueue statement completed (transaction may still be pending)");
}

export async function claimJobs(sql: Database, workerId: string, kinds: JobKind[], limit = 3) {
  return sql.begin(async (transaction) => transaction<Job[]>`
    WITH next_jobs AS (
      SELECT id
      FROM jobs
      WHERE status = 'queued'
        AND available_at <= now()
        AND kind = ANY(${kinds})
      ORDER BY available_at, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE jobs
    SET status = 'processing',
      locked_at = now(),
      locked_by = ${workerId},
      attempts = attempts + 1
    FROM next_jobs
    WHERE jobs.id = next_jobs.id
    RETURNING jobs.id, jobs.kind, jobs.payload, jobs.attempts, jobs.max_attempts
  `);
}

export async function recoverStaleJobs(sql: Database) {
  const result = await sql`
    UPDATE jobs
    SET status = 'queued', locked_at = NULL, locked_by = NULL
    WHERE status = 'processing'
      AND locked_at < now() - interval '15 minutes'
  `;
  if (result.count) currentLog().warn({ event: "jobs.recovered", count: result.count }, "Stale jobs returned to queue");
}

export async function completeJob(sql: Database, jobId: string) {
  await sql`
    UPDATE jobs
    SET status = 'done', completed_at = now(), locked_at = NULL, locked_by = NULL
    WHERE id = ${jobId}
  `;
}

export async function failJob(sql: Database, job: Job, errorCode: string, retryable: boolean) {
  const willRetry = retryable && job.attempts < job.max_attempts;

  if (willRetry) {
    await sql`
      UPDATE jobs
      SET status = 'queued',
        available_at = now() + ${retryDelaySeconds(job.attempts)} * interval '1 second',
        locked_at = NULL,
        locked_by = NULL,
        last_error_code = ${errorCode}
      WHERE id = ${job.id}
    `;
  } else {
    await sql`
      UPDATE jobs
      SET status = 'failed',
        completed_at = now(),
        locked_at = NULL,
        locked_by = NULL,
        last_error_code = ${errorCode}
      WHERE id = ${job.id}
    `;
  }

  return willRetry;
}

function retryDelaySeconds(attempt: number) {
  return [60, 300, 1_800, 7_200][Math.min(attempt - 1, 3)]!;
}
