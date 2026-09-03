import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../app.js";
import { createDatabase } from "../../shared/db.js";
import { applyMigrations } from "../../shared/migrations.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("uploads cards atomically and completes an unknown-card review round", { skip: !databaseUrl, timeout: 20_000 }, async () => {
  const sql = createDatabase(databaseUrl);
  await applyMigrations(sql);
  await sql.unsafe("TRUNCATE jobs, users CASCADE");

  const app = buildApp(sql);
  try {
    const uploaded = await app.inject(multipartRequest("words.csv", "word,meaning\ncalm,침착한\ncalm,평온한\n"));
    assert.equal(uploaded.statusCode, 201);
    const uploadBody = uploaded.json() as { day: { id: string; dayNumber: number; rowCount: number }; exampleJobsQueued: number };
    assert.equal(uploadBody.day.dayNumber, 1);
    assert.equal(uploadBody.day.rowCount, 2);
    assert.equal(uploadBody.exampleJobsQueued, 2);
    const savedCards = await sql<{ term: string; meaning: string }[]>`
      SELECT term, meaning
      FROM cards
      ORDER BY source_row
    `;
    assert.deepEqual(Array.from(savedCards), [
      { term: "calm", meaning: "침착한" },
      { term: "calm", meaning: "평온한" },
    ]);
    const queuedJobs = await sql<{ count: string }[]>`
      SELECT count(*)
      FROM jobs
      WHERE kind = 'generate_example'
        AND status = 'queued'
    `;
    assert.equal(Number(queuedJobs[0]!.count), 2);

    const failedUpload = await app.inject(multipartRequest("broken.csv", "word,meaning\nmissing,\n"));
    assert.equal(failedUpload.statusCode, 400);
    assert.deepEqual(failedUpload.json(), {
      error: {
        code: "INVALID_ROWS",
        message: "단어와 뜻을 모두 입력해야 하며 길이 제한을 지켜야 합니다.",
        rows: [2],
      },
    });

    const days = await app.inject({ method: "GET", url: "/api/days" });
    const dayList = days.json() as { days: Array<{ id: string; dayNumber: number; rowCount: number }> };
    assert.deepEqual(dayList.days.map((day) => ({ dayNumber: day.dayNumber, rowCount: day.rowCount })), [{ dayNumber: 1, rowCount: 2 }]);

    const started = await app.inject({
      method: "POST",
      url: "/api/study/sessions",
      payload: { targetDayId: uploadBody.day.id },
    });
    assert.equal(started.statusCode, 201);
    const session = started.json() as { session: { id: string }; roundNumber: number; cards: Array<{ id: string }> };
    assert.equal(session.cards.length, 2);

    for (const [index, card] of session.cards.entries()) {
      const attempt = await app.inject({
        method: "POST",
        url: `/api/study/sessions/${session.session.id}/attempts`,
        payload: {
          idempotencyKey: crypto.randomUUID(),
          cardId: card.id,
          roundNumber: 1,
          position: index + 1,
          result: index === 0 ? "unknown" : "known",
          responseMs: 100,
          revealedAtMs: 50,
        },
      });
      assert.equal(attempt.statusCode, 200);
    }

    const secondRound = await app.inject({ method: "POST", url: `/api/study/sessions/${session.session.id}/rounds` });
    assert.equal(secondRound.statusCode, 200);
    const secondRoundBody = secondRound.json() as { completed: boolean; roundNumber: number; cards: Array<{ id: string }> };
    assert.equal(secondRoundBody.completed, false);
    assert.equal(secondRoundBody.roundNumber, 2);
    assert.equal(secondRoundBody.cards.length, 1);

    const finalAttempt = await app.inject({
      method: "POST",
      url: `/api/study/sessions/${session.session.id}/attempts`,
      payload: {
        idempotencyKey: crypto.randomUUID(),
        cardId: secondRoundBody.cards[0]!.id,
        roundNumber: 2,
        position: 1,
        result: "known",
        responseMs: 100,
        revealedAtMs: 50,
      },
    });
    assert.equal(finalAttempt.statusCode, 200);

    const completed = await app.inject({ method: "POST", url: `/api/study/sessions/${session.session.id}/rounds` });
    const completedBody = completed.json() as { completed: boolean; session: { knownCount: number; unknownCount: number; roundsCompleted: number } };
    assert.equal(completed.statusCode, 200);
    assert.equal(completedBody.completed, true);
    assert.equal(completedBody.session.knownCount, 2);
    assert.equal(completedBody.session.unknownCount, 1);
    assert.equal(completedBody.session.roundsCompleted, 2);

    const day2Response = await app.inject(multipartRequest("day2.csv", "word,meaning\nsecond,둘째\n"));
    const day3Response = await app.inject(multipartRequest("day3.csv", "word,meaning\nthird-a,셋째 A\nthird-b,셋째 B\n"));
    assert.equal(day2Response.statusCode, 201);
    assert.equal(day3Response.statusCode, 201);
    const day3 = day3Response.json() as { day: { id: string } };

    const grouped = await app.inject({ method: "POST", url: "/api/study/sessions", payload: { targetDayId: day3.day.id } });
    const groupedBody = grouped.json() as { session: { id: string }; cards: Array<{ id: string }> };
    assert.equal(grouped.statusCode, 201);
    assert.equal(groupedBody.cards.length, 3);

    for (const [index, card] of groupedBody.cards.entries()) {
      const attempt = await app.inject({
        method: "POST",
        url: `/api/study/sessions/${groupedBody.session.id}/attempts`,
        payload: {
          idempotencyKey: crypto.randomUUID(), cardId: card.id, roundNumber: 1, position: index + 1,
          result: "unknown", responseMs: 100, revealedAtMs: 50,
        },
      });
      assert.equal(attempt.statusCode, 200);
    }

    const groupedRound = await app.inject({ method: "POST", url: `/api/study/sessions/${groupedBody.session.id}/rounds` });
    const groupedRoundBody = groupedRound.json() as { cards: Array<{ id: string }> };
    const reReviewDays = await sql<{ id: string; day_number: number }[]>`
      SELECT cards.id, days.day_number FROM cards JOIN days ON days.id = cards.day_id
      WHERE cards.id = ANY(${groupedRoundBody.cards.map((card) => card.id)})
    `;
    const dayByCardId = new Map(reReviewDays.map((card) => [card.id, card.day_number]));
    assert.deepEqual(groupedRoundBody.cards.map((card) => dayByCardId.get(card.id)), [3, 3, 2]);
  } finally {
    await app.close();
  }
});

function multipartRequest(filename: string, csv: string) {
  const boundary = "chanvoca-test-boundary";
  return {
    method: "POST" as const,
    url: "/api/days/upload",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`),
  };
}
