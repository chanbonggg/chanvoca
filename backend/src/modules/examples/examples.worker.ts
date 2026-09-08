import { setStage, currentLog, logContext } from "../../shared/logger.js";
import type { Database } from "../../shared/db.js";
import type { Job } from "../../shared/jobs.js";
import { ExampleGenerationError, generateExample } from "./example-generator.js";

type CardRow = {
  id: string;
  term: string;
  meaning: string;
  example_status: "pending" | "processing" | "ready" | "failed";
};

type ProcessResult =
  | { completed: true }
  | { completed: false; cardId: string; error: ExampleGenerationError };

export async function processExampleJob(sql: Database, job: Job): Promise<ProcessResult> {
  const cardId = cardIdFrom(job.payload);
  if (!cardId) {
    currentLog().warn({ event: "example.skipped", reason: "invalid_payload" }, "Example job skipped");
    return { completed: true };
  }

  setStage("example.load_card");
  const cards = await sql<CardRow[]>`
    SELECT id, term, meaning, example_status
    FROM cards
    WHERE id = ${cardId}
  `;
  const card = cards[0];

  if (!card || card.example_status === "ready") {
    currentLog().info({ event: "example.skipped", cardId, reason: card ? "already_ready" : "card_missing" }, "Example job skipped");
    return { completed: true };
  }

  setStage("example.mark_processing");
  await sql`
    UPDATE cards
    SET example_status = 'processing', example_error_code = NULL, updated_at = now()
    WHERE id = ${card.id}
  `;

  try {
    setStage("examples.generate");
    const example = await generateExample(card.term, card.meaning);
    setStage("example.save");
    await sql`
      UPDATE cards
      SET example_en = ${example.exampleEn},
        example_ko = ${example.exampleKo},
        example_status = 'ready',
        example_error_code = NULL,
        updated_at = now()
      WHERE id = ${card.id}
    `;
    currentLog().info({ event: "example.saved", cardId }, "Example saved");
    return { completed: true };
  } catch (error) {
    currentLog().error({ event: "example.failed", cardId, stage: logContext.getStore()?.stage, err: error }, "Example generation or persistence failed");
    const failure = error instanceof ExampleGenerationError
      ? error
      : new ExampleGenerationError("GROQ_NETWORK", true);

    setStage("example.mark_pending");
    await sql`
      UPDATE cards
      SET example_status = 'pending', example_error_code = ${failure.code}, updated_at = now()
      WHERE id = ${card.id}
    `;
    return { completed: false, cardId: card.id, error: failure };
  }
}

export async function markExampleFailed(sql: Database, cardId: string, errorCode: string) {
  setStage("example.mark_failed");
  await sql`
    UPDATE cards
    SET example_status = 'failed', example_error_code = ${errorCode}, updated_at = now()
    WHERE id = ${cardId}
  `;
}

function cardIdFrom(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>).cardId;
  return typeof value === "string" ? value : null;
}
