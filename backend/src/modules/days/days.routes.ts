import { validVocabulary } from "./vocabulary.js";
import { setStage } from "../../shared/logger.js";
import type { FastifyInstance } from "fastify";

import type { Database } from "../../shared/db.js";
import { parseVocabularyFile } from "./vocabulary-parser.js";
import { requestUser } from "../auth/index.js";

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

export async function registerDaysRoutes(app: FastifyInstance, sql: Database, maxDailyCards: number) {
  app.patch<{ Params: { dayId: string; cardId: string }; Body: unknown }>("/:dayId/cards/:cardId", async (request, reply) => {
    const { dayId, cardId } = request.params;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(dayId) || !uuid.test(cardId)) return reply.code(400).send(errorPayload("INVALID_ID", "올바른 Day와 단어 ID가 필요합니다."));
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["term", "meaning"].includes(key))) {
      return reply.code(400).send(errorPayload("INVALID_INPUT", "단어와 뜻만 수정할 수 있습니다."));
    }
    const input = body as { term?: unknown; meaning?: unknown };
    const term = typeof input.term === "string" ? input.term.trim() : input.term;
    const meaning = typeof input.meaning === "string" ? input.meaning.trim() : input.meaning;
    if (!validVocabulary(term, meaning)) return reply.code(400).send(errorPayload("INVALID_INPUT", "단어는 1~200자, 뜻은 1~1,000자로 입력하세요."));
    const userId = requestUser(request).id;
    const rows = await sql<{ id: string; term: string; meaning: string }[]>`
      UPDATE cards SET term = ${term as string}, meaning = ${meaning as string}
      FROM days WHERE cards.id = ${cardId} AND cards.day_id = days.id
        AND days.id = ${dayId} AND days.user_id = ${userId}
      RETURNING cards.id, cards.term, cards.meaning
    `;
    if (!rows[0]) return reply.code(404).send(errorPayload("CARD_NOT_FOUND", "단어를 찾을 수 없습니다."));
    return { card: rows[0] };
  });

  app.get("/", async (request) => {
    const userId = requestUser(request).id;
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
      WHERE days.user_id = ${userId}
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
      const userId = requestUser(request).id;
      setStage("upload.lock_day_number");
      await transaction`SELECT pg_advisory_xact_lock(hashtext(${`days:${userId}`}))`;

      const usage = await transaction<{ used: number; retry: number }[]>`
        SELECT COALESCE(sum(row_count), 0)::int AS used,
          greatest(1, ceil(extract(epoch FROM ((date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') + interval '1 day') AT TIME ZONE 'Asia/Seoul') - now())))::int AS retry
        FROM days WHERE user_id = ${userId}
          AND imported_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'
          AND imported_at < (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') + interval '1 day') AT TIME ZONE 'Asia/Seoul'
      `;
      if (usage[0].used + parsed.cards.length > maxDailyCards) return { limited: true as const, retry: usage[0].retry };
      setStage("upload.find_latest_day");
      const latest = await transaction<{ day_number: number }[]>`
        SELECT day_number
        FROM days
        WHERE user_id = ${userId}
        ORDER BY day_number DESC
        LIMIT 1
      `;
      const dayNumber = (latest[0]?.day_number ?? 0) + 1;
      setStage("upload.insert_day");
      const insertedDays = await transaction<{ id: string; imported_at: string }[]>`
        INSERT INTO days ${transaction({
          user_id: userId,
          day_number: dayNumber,
          original_filename: file.filename.slice(0, 255),
          source_format: parsed.sourceFormat,
          row_count: parsed.cards.length,
        })}
        RETURNING id, imported_at
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

      return {
        id: dayId, dayNumber, rowCount: cards.length,
        originalFilename: file.filename.slice(0, 255),
        importedAt: insertedDays[0]!.imported_at,
        examples: { ready: 0, pending: cards.length, processing: 0, failed: 0 },
      };
    });

    if ("limited" in day) return reply.header("retry-after", day.retry).code(429).send(errorPayload("DAILY_CARD_LIMIT", "오늘의 업로드 한도에 도달했습니다. 내일 다시 시도하세요."));
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
