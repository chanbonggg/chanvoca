import { setStage } from "../../shared/logger.js";
import type { FastifyInstance } from "fastify";

import type { Database } from "../../shared/db.js";
import { parseVocabularyFile } from "./vocabulary-parser.js";
import { getOwnerId } from "../system/owner.js";

type DayListRow = {
  id: string;
  day_number: number;
  original_filename: string;
  row_count: number;
  imported_at: string;
  example_ready: string;
  example_pending: string;
  example_processing: string;
  example_failed: string;
};

export async function registerDaysRoutes(app: FastifyInstance, sql: Database) {
  app.get("/", async () => {
    const ownerId = await getOwnerId(sql);
    setStage("days.list");
    const rows = await sql<DayListRow[]>`
      SELECT
        days.id,
        days.day_number,
        days.original_filename,
        days.row_count,
        days.imported_at,
        count(cards.id) FILTER (WHERE cards.example_status = 'ready') AS example_ready,
        count(cards.id) FILTER (WHERE cards.example_status = 'pending') AS example_pending,
        count(cards.id) FILTER (WHERE cards.example_status = 'processing') AS example_processing,
        count(cards.id) FILTER (WHERE cards.example_status = 'failed') AS example_failed
      FROM days
      LEFT JOIN cards ON cards.day_id = days.id
      WHERE days.user_id = ${ownerId}
      GROUP BY days.id
      ORDER BY days.day_number DESC
    `;

    return {
      days: rows.map((row) => ({
        id: row.id,
        dayNumber: row.day_number,
        originalFilename: row.original_filename,
        rowCount: row.row_count,
        importedAt: row.imported_at,
        examples: {
          ready: Number(row.example_ready),
          pending: Number(row.example_pending),
          processing: Number(row.example_processing),
          failed: Number(row.example_failed),
        },
      })),
    };
  });

  app.post("/upload", async (request, reply) => {
    let file;
    try {
      file = await request.file();
    } catch (error) {
      if (isFileTooLarge(error)) return reply.code(413).send(errorPayload("FILE_TOO_LARGE", "파일은 최대 10 MiB까지 업로드할 수 있습니다."));
      throw error;
    }

    if (!file) return reply.code(400).send(errorPayload("FILE_REQUIRED", "업로드할 파일이 필요합니다."));

    let content: Buffer;
    try {
      content = await file.toBuffer();
    } catch (error) {
      if (isFileTooLarge(error)) return reply.code(413).send(errorPayload("FILE_TOO_LARGE", "파일은 최대 10 MiB까지 업로드할 수 있습니다."));
      throw error;
    }

    const parsed = parseVocabularyFile(file.filename, content);
    if (!parsed.ok) {
      request.log.warn({ event: "upload.invalid", errorCode: parsed.code, rows: parsed.rows, bytes: content.length }, "Vocabulary validation failed");
      return reply.code(parsed.code === "TOO_MANY_ROWS" ? 413 : 400).send({
        error: { code: parsed.code, message: parsed.message, ...(parsed.rows ? { rows: parsed.rows } : {}) },
      });
    }

    setStage("upload.transaction");
    request.log.info({ event: "upload.parsed", rowCount: parsed.cards.length, sourceFormat: parsed.sourceFormat, bytes: content.length }, "Vocabulary parsed");
    const day = await sql.begin(async (transaction) => {
      const ownerId = await getOwnerId(transaction);
      setStage("upload.lock_day_number");
      await transaction`SELECT pg_advisory_xact_lock(hashtext(${`days:${ownerId}`}))`;

      setStage("upload.find_latest_day");
      const latest = await transaction<{ day_number: number }[]>`
        SELECT day_number
        FROM days
        WHERE user_id = ${ownerId}
        ORDER BY day_number DESC
        LIMIT 1
      `;
      const dayNumber = (latest[0]?.day_number ?? 0) + 1;
      setStage("upload.insert_day");
      const insertedDays = await transaction<{ id: string }[]>`
        INSERT INTO days ${transaction({
          user_id: ownerId,
          day_number: dayNumber,
          original_filename: file.filename.slice(0, 255),
          source_format: parsed.sourceFormat,
          row_count: parsed.cards.length,
        })}
        RETURNING id
      `;
      const dayId = insertedDays[0]!.id;
      setStage("upload.insert_cards");
      const cards = await transaction<{ id: string }[]>`
        INSERT INTO cards ${transaction(
          parsed.cards.map((card) => ({
            day_id: dayId,
            source_row: card.sourceRow,
            term: card.term,
            meaning: card.meaning,
          })),
        )}
        RETURNING id
      `;

      setStage("upload.enqueue_examples");
      await transaction`
        INSERT INTO jobs ${transaction(
          cards.map((card) => ({
            kind: "generate_example",
            dedupe_key: `card:${card.id}`,
            payload: transaction.json({ cardId: card.id, traceId: request.id }),
          })),
        )}
        ON CONFLICT (kind, dedupe_key) DO NOTHING
      `;

      return { id: dayId, dayNumber, rowCount: cards.length };
    });

    request.log.info({ event: "upload.committed", dayId: day.id, dayNumber: day.dayNumber, rowCount: day.rowCount, jobsQueued: day.rowCount }, "Vocabulary import committed");
    return reply.code(201).send({ day, exampleJobsQueued: day.rowCount });
  });
}

function isFileTooLarge(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "FST_REQ_FILE_TOO_LARGE";
}

function errorPayload(code: string, message: string) {
  return { error: { code, message } };
}
