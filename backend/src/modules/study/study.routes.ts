import type { FastifyInstance } from "fastify";

import type { Database, Queryable } from "../../shared/db.js";
import { getOwnerId } from "../system/owner.js";
import { reviewDayNumbers, shuffled, shuffledWithinDays } from "./review-plan.js";

type DayRow = { id: string; day_number: number };
type CardRow = {
  id: string;
  day_number: number;
  term: string;
  meaning: string;
  example_en: string | null;
  example_ko: string | null;
  example_status: "pending" | "processing" | "ready" | "failed";
};
type SessionRow = {
  id: string;
  target_day_id: string;
  target_day_number: number;
  plan_day_numbers: number[];
  status: "in_progress" | "completed" | "abandoned";
  total_cards: number;
  known_count: number;
  unknown_count: number;
  timeout_count: number;
  rounds_completed: number;
  repeat_of_session_id: string | null;
};
type AttemptRow = { card_id: string; result: "known" | "unknown" | "timeout" };

type CreateSessionBody = {
  targetDayId?: string;
  repeatOfSessionId?: string;
};

type AttemptBody = {
  idempotencyKey?: string;
  cardId?: string;
  roundNumber?: number;
  position?: number;
  result?: "known" | "unknown" | "timeout";
  responseMs?: number;
  revealedAtMs?: number | null;
};

type ValidAttempt = {
  idempotencyKey: string;
  cardId: string;
  roundNumber: number;
  position: number;
  result: "known" | "unknown" | "timeout";
  responseMs: number;
  revealedAtMs: number | null;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function registerStudyRoutes(app: FastifyInstance, sql: Database) {
  app.post<{ Body: CreateSessionBody }>("/sessions", async (request, reply) => {
    const body = request.body ?? {};

    if (body.targetDayId && body.repeatOfSessionId) {
      return reply.code(400).send(error("TARGET_AND_REPEAT_CONFLICT", "Day 선택과 전체 반복은 함께 사용할 수 없습니다."));
    }

    const result = await sql.begin(async (transaction) => {
      const ownerId = await getOwnerId(transaction);
      const target = await findTargetDay(transaction, ownerId, body);

      if (!target) return null;

      const planNumbers = reviewDayNumbers(target.day_number);
      const planDays = await transaction<DayRow[]>`
        SELECT id, day_number
        FROM days
        WHERE user_id = ${ownerId}
          AND day_number = ANY(${planNumbers})
        ORDER BY day_number DESC
      `;
      const cards = await transaction<CardRow[]>`
        SELECT cards.id, days.day_number, cards.term, cards.meaning, cards.example_en, cards.example_ko, cards.example_status
        FROM cards
        JOIN days ON days.id = cards.day_id
        WHERE days.id = ANY(${planDays.map((day) => day.id)})
      `;

      if (cards.length === 0) return null;

      const sessionRows = await transaction<SessionRow[]>`
        INSERT INTO study_sessions ${transaction({
          user_id: ownerId,
          target_day_id: target.id,
          target_day_number: target.day_number,
          plan_day_numbers: planDays.map((day) => day.day_number),
          total_cards: cards.length,
          repeat_of_session_id: body.repeatOfSessionId ?? null,
        })}
        RETURNING id, target_day_id, target_day_number, plan_day_numbers, status,
          total_cards, known_count, unknown_count, timeout_count, rounds_completed, repeat_of_session_id
      `;
      const session = sessionRows[0]!;
      const firstRound = shuffled(cards);

      await transaction`
        INSERT INTO study_session_cards ${transaction(
          firstRound.map((card, index) => ({
            session_id: session.id,
            card_id: card.id,
            initial_order: index + 1,
          })),
          "session_id",
          "card_id",
          "initial_order",
        )}
      `;

      return { session, cards: firstRound };
    });

    if (!result) {
      return reply.code(404).send(error("DAY_NOT_FOUND", "학습할 Day 또는 카드가 없습니다."));
    }

    return reply.code(201).send({
      session: sessionPayload(result.session),
      roundNumber: 1,
      cards: result.cards.map(cardPayload),
    });
  });

  app.get<{ Params: { sessionId: string } }>("/sessions/:sessionId", async (request, reply) => {
    const ownerId = await getOwnerId(sql);
    const session = await sessionForOwner(sql, request.params.sessionId, ownerId);

    if (!session) return reply.code(404).send(error("SESSION_NOT_FOUND", "학습 세션을 찾을 수 없습니다."));

    const roundNumber = session.rounds_completed + 1;
    const pendingCards = await cardsForCurrentRound(sql, session, roundNumber);

    return {
      session: sessionPayload(session),
      roundNumber,
      roundComplete: pendingCards.length === 0 && session.status === "in_progress",
      cards: pendingCards.map(cardPayload),
    };
  });

  app.post<{ Params: { sessionId: string }; Body: AttemptBody }>(
    "/sessions/:sessionId/attempts",
    async (request, reply) => {
      const body = request.body ?? {};

      if (!isValidAttempt(body)) {
        return reply.code(400).send(error("INVALID_ATTEMPT", "학습 결과 형식이 올바르지 않습니다."));
      }
      const attempt = body;

      const result = await sql.begin(async (transaction) => {
        const ownerId = await getOwnerId(transaction);
        const session = await sessionForOwner(transaction, request.params.sessionId, ownerId);

        if (!session || session.status !== "in_progress") return null;
        if (attempt.roundNumber !== session.rounds_completed + 1) return "round-mismatch" as const;

        const existing = await transaction<AttemptRow[]>`
          SELECT card_id, result
          FROM study_attempts
          WHERE session_id = ${session.id}
            AND idempotency_key = ${attempt.idempotencyKey}
        `;
        if (existing[0]) return "duplicate" as const;

        const active = await transaction<{ card_id: string }[]>`
          SELECT card_id
          FROM study_session_cards
          WHERE session_id = ${session.id}
            AND card_id = ${attempt.cardId}
            AND passed_at_round IS NULL
        `;
        if (!active[0]) return "card-mismatch" as const;

        await transaction`
          INSERT INTO study_attempts ${transaction({
            session_id: session.id,
            card_id: attempt.cardId,
            round_number: attempt.roundNumber,
            position: attempt.position,
            result: attempt.result,
            response_ms: attempt.responseMs,
            revealed_at_ms: attempt.revealedAtMs,
            idempotency_key: attempt.idempotencyKey,
          })}
        `;

        if (attempt.result === "known") {
          await transaction`
            UPDATE study_session_cards
            SET passed_at_round = ${attempt.roundNumber}
            WHERE session_id = ${session.id}
            AND card_id = ${attempt.cardId}
          `;
          await transaction`
            UPDATE study_sessions
            SET known_count = known_count + 1
            WHERE id = ${session.id}
          `;
        } else if (attempt.result === "unknown") {
          await transaction`
            UPDATE study_sessions
            SET unknown_count = unknown_count + 1
            WHERE id = ${session.id}
          `;
        } else {
          await transaction`
            UPDATE study_sessions
            SET timeout_count = timeout_count + 1
            WHERE id = ${session.id}
          `;
        }

        return "accepted" as const;
      });

      if (result === "accepted" || result === "duplicate") return { accepted: true };
      if (result === "round-mismatch") return reply.code(409).send(error("ROUND_MISMATCH", "현재 라운드와 맞지 않는 결과입니다."));
      if (result === "card-mismatch") return reply.code(409).send(error("CARD_MISMATCH", "현재 학습 대상 카드가 아닙니다."));

      return reply.code(404).send(error("SESSION_NOT_FOUND", "진행 중인 학습 세션을 찾을 수 없습니다."));
    },
  );

  app.post<{ Params: { sessionId: string } }>("/sessions/:sessionId/rounds", async (request, reply) => {
    const result = await sql.begin(async (transaction) => {
      const ownerId = await getOwnerId(transaction);
      const session = await sessionForOwner(transaction, request.params.sessionId, ownerId);

      if (!session || session.status !== "in_progress") return null;

      const roundNumber = session.rounds_completed + 1;
      const expected = await transaction<{ count: string }[]>`
        SELECT count(*)
        FROM study_session_cards
        WHERE session_id = ${session.id}
          AND (passed_at_round IS NULL OR passed_at_round = ${roundNumber})
      `;
      const recorded = await transaction<{ count: string }[]>`
        SELECT count(DISTINCT card_id)
        FROM study_attempts
        WHERE session_id = ${session.id}
          AND round_number = ${roundNumber}
      `;

      if (Number(expected[0]!.count) !== Number(recorded[0]!.count)) return "incomplete" as const;

      const remaining = await transaction<CardRow[]>`
        SELECT cards.id, days.day_number, cards.term, cards.meaning, cards.example_en, cards.example_ko, cards.example_status
        FROM study_session_cards
        JOIN cards ON cards.id = study_session_cards.card_id
        JOIN days ON days.id = cards.day_id
        WHERE study_session_cards.session_id = ${session.id}
          AND study_session_cards.passed_at_round IS NULL
      `;

      if (remaining.length === 0) {
        const completed = await transaction<SessionRow[]>`
          UPDATE study_sessions
          SET status = 'completed', rounds_completed = ${roundNumber}, completed_at = now()
          WHERE id = ${session.id}
          RETURNING id, target_day_id, target_day_number, plan_day_numbers, status,
            total_cards, known_count, unknown_count, timeout_count, rounds_completed, repeat_of_session_id
        `;
        return { completed: true, session: completed[0]!, cards: [] as CardRow[] };
      }

      const advanced = await transaction<SessionRow[]>`
        UPDATE study_sessions
        SET rounds_completed = ${roundNumber}
        WHERE id = ${session.id}
        RETURNING id, target_day_id, target_day_number, plan_day_numbers, status,
          total_cards, known_count, unknown_count, timeout_count, rounds_completed, repeat_of_session_id
      `;
      return { completed: false, session: advanced[0]!, cards: shuffledWithinDays(remaining, (card) => card.day_number) };
    });

    if (result === "incomplete") return reply.code(409).send(error("ROUND_INCOMPLETE", "현재 라운드의 모든 카드 결과를 먼저 저장하세요."));
    if (!result) return reply.code(404).send(error("SESSION_NOT_FOUND", "진행 중인 학습 세션을 찾을 수 없습니다."));

    return {
      completed: result.completed,
      session: sessionPayload(result.session),
      roundNumber: result.session.rounds_completed + (result.completed ? 0 : 1),
      cards: result.cards.map(cardPayload),
    };
  });
}

async function findTargetDay(sql: Queryable, ownerId: string, body: CreateSessionBody) {
  if (body.repeatOfSessionId) {
    const repeated = await sql<DayRow[]>`
      SELECT days.id, days.day_number
      FROM study_sessions
      JOIN days ON days.id = study_sessions.target_day_id
      WHERE study_sessions.id = ${body.repeatOfSessionId}
        AND study_sessions.user_id = ${ownerId}
        AND study_sessions.status = 'completed'
    `;
    return repeated[0];
  }

  if (body.targetDayId) {
    const selected = await sql<DayRow[]>`
      SELECT id, day_number
      FROM days
      WHERE id = ${body.targetDayId}
        AND user_id = ${ownerId}
    `;
    return selected[0];
  }

  const latest = await sql<DayRow[]>`
    SELECT id, day_number
    FROM days
    WHERE user_id = ${ownerId}
    ORDER BY day_number DESC
    LIMIT 1
  `;
  return latest[0];
}

async function sessionForOwner(sql: Queryable, sessionId: string, ownerId: string) {
  const sessions = await sql<SessionRow[]>`
    SELECT id, target_day_id, target_day_number, plan_day_numbers, status,
      total_cards, known_count, unknown_count, timeout_count, rounds_completed, repeat_of_session_id
    FROM study_sessions
    WHERE id = ${sessionId}
      AND user_id = ${ownerId}
  `;
  return sessions[0];
}

async function cardsForCurrentRound(sql: Queryable, session: SessionRow, roundNumber: number) {
  const cards = await sql<CardRow[]>`
    SELECT cards.id, days.day_number, cards.term, cards.meaning, cards.example_en, cards.example_ko, cards.example_status,
      study_session_cards.initial_order
    FROM study_session_cards
    JOIN cards ON cards.id = study_session_cards.card_id
    JOIN days ON days.id = cards.day_id
    WHERE study_session_cards.session_id = ${session.id}
      AND study_session_cards.passed_at_round IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM study_attempts
        WHERE study_attempts.session_id = ${session.id}
          AND study_attempts.card_id = cards.id
          AND study_attempts.round_number = ${roundNumber}
      )
    ORDER BY CASE WHEN ${roundNumber} = 1 THEN study_session_cards.initial_order END, random()
  `;
  return cards;
}

function sessionPayload(session: SessionRow) {
  return {
    id: session.id,
    targetDayId: session.target_day_id,
    targetDayNumber: session.target_day_number,
    planDayNumbers: session.plan_day_numbers,
    status: session.status,
    totalCards: session.total_cards,
    knownCount: session.known_count,
    unknownCount: session.unknown_count,
    timeoutCount: session.timeout_count,
    roundsCompleted: session.rounds_completed,
    repeatOfSessionId: session.repeat_of_session_id,
  };
}

function cardPayload(card: CardRow) {
  return {
    id: card.id,
    term: card.term,
    meaning: card.meaning,
    exampleEn: card.example_en,
    exampleKo: card.example_ko,
    exampleStatus: card.example_status,
  };
}

function isValidAttempt(body: AttemptBody): body is ValidAttempt {
  const { idempotencyKey, cardId, roundNumber, position, result, responseMs, revealedAtMs } = body;

  return Boolean(
    typeof idempotencyKey === "string" && uuidPattern.test(idempotencyKey) &&
      typeof cardId === "string" && uuidPattern.test(cardId) &&
      typeof roundNumber === "number" && Number.isInteger(roundNumber) && roundNumber > 0 &&
      typeof position === "number" && Number.isInteger(position) && position > 0 &&
      (result === "known" || result === "unknown" || result === "timeout") &&
      typeof responseMs === "number" && Number.isInteger(responseMs) && responseMs >= 0 &&
      (revealedAtMs === null || (typeof revealedAtMs === "number" && Number.isInteger(revealedAtMs) && revealedAtMs >= 0)),
  );
}

function error(code: string, message: string) {
  return { error: { code, message } };
}
