import { loginOwner, testConfig, testDatabaseUrl } from "../../test-support.js";
import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";

import { buildApp } from "../../app.js";
import { createDatabase } from "../../shared/db.js";
import { applyMigrations } from "../../shared/migrations.js";

const databaseUrl = testDatabaseUrl();

test("uploads cards atomically and completes an unknown-card review round", { timeout: 20_000 }, async () => {
  const sql = createDatabase(databaseUrl);
  await applyMigrations(sql);
  await sql.unsafe("TRUNCATE jobs, users CASCADE");

  const app = buildApp(sql, undefined, testConfig);
  const cookie = await loginOwner(app, sql);
  const inject = (options: import("fastify").InjectOptions) => app.inject({ ...options, headers: { cookie, origin: testConfig.origin, ...options.headers } });
  try {
    const uploaded = await inject(multipartRequest("words.csv", "word,meaning\ncalm,침착한\ncalm,평온한\n"));
    assert.equal(uploaded.statusCode, 201);
    const uploadBody = uploaded.json() as { day: { id: string; dayNumber: number; rowCount: number }; exampleJobsQueued: number };
    assert.equal(uploadBody.day.dayNumber, 1);
    assert.equal(uploadBody.day.rowCount, 2);
    assert.equal(uploadBody.exampleJobsQueued, 2);
    assert.deepEqual(uploaded.json().day.examples, { ready: 0, pending: 2, processing: 0, failed: 0 });
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

    const failedUpload = await inject(multipartRequest("broken.csv", "word,meaning\nmissing,\n"));
    assert.equal(failedUpload.statusCode, 400);
    assert.deepEqual(failedUpload.json(), {
      error: {
        code: "INVALID_ROWS",
        message: "단어와 뜻을 모두 입력해야 하며 길이 제한을 지켜야 합니다.",
        rows: [2],
      },
    });

    const days = await inject({ method: "GET", url: "/api/days" });
    assert.deepEqual(uploaded.json().day, days.json().days[0]);
    const dayList = days.json() as { days: Array<{ id: string; dayNumber: number; rowCount: number }> };
    assert.deepEqual(dayList.days.map((day) => ({ dayNumber: day.dayNumber, rowCount: day.rowCount })), [{ dayNumber: 1, rowCount: 2 }]);

    const started = await inject({
      method: "POST",
      url: "/api/study/sessions",
      payload: { targetDayId: uploadBody.day.id },
    });
    assert.equal(started.statusCode, 201);
    const session = started.json() as { session: { id: string }; roundNumber: number; cards: Array<{ id: string }> };
    assert.equal(session.cards.length, 2);

    const listUrl = `/api/study/sessions/${session.session.id}/days/${uploadBody.day.id}/cards`;
    const initialList = await inject({ method: "GET", url: listUrl });
    assert.equal(initialList.statusCode, 200);
    assert.deepEqual(initialList.json().cards.map((card: { meaning: string; status: string }) => [card.meaning, card.status]), [
      ["침착한", "unseen"], ["평온한", "unseen"],
    ]);
    assert.equal((await inject({ method: "GET", url: `/api/study/sessions/invalid/days/${uploadBody.day.id}/cards` })).statusCode, 400);
    assert.equal((await inject({ method: "GET", url: `/api/study/sessions/${crypto.randomUUID()}/days/${uploadBody.day.id}/cards` })).statusCode, 404);

    for (const [index, card] of session.cards.entries()) {
      const attempt = await inject({
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

    const secondRound = await inject({ method: "POST", url: `/api/study/sessions/${session.session.id}/rounds` });
    assert.equal(secondRound.statusCode, 200);
    const secondRoundBody = secondRound.json() as { completed: boolean; roundNumber: number; cards: Array<{ id: string }> };
    assert.equal(secondRoundBody.completed, false);
    assert.equal(secondRoundBody.roundNumber, 2);
    assert.equal(secondRoundBody.cards.length, 1);
    const reviewedList = (await inject({ method: "GET", url: listUrl })).json();
    assert.equal(reviewedList.cards.length, 2); // Passed cards remain visible in the full DAY list.
    for (const card of reviewedList.cards) {
      assert.equal(card.status, card.id === session.cards[0]!.id ? "unknown" : "known");
    }

    const finalAttempt = await inject({
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

    const completed = await inject({ method: "POST", url: `/api/study/sessions/${session.session.id}/rounds` });
    const completedBody = completed.json() as { completed: boolean; session: { knownCount: number; unknownCount: number; roundsCompleted: number } };
    assert.equal(completed.statusCode, 200);
    assert.equal(completedBody.completed, true);
    assert.equal(completedBody.session.knownCount, 2);
    assert.equal(completedBody.session.unknownCount, 1);
    assert.equal(completedBody.session.roundsCompleted, 2);
    assert.ok((await inject({ method: "GET", url: listUrl })).json().cards.every((card: { status: string }) => card.status === "known"));
    const repeated = (await inject({ method: "POST", url: "/api/study/sessions", payload: { repeatOfSessionId: session.session.id } })).json();
    const repeatedList = (await inject({ method: "GET", url: `/api/study/sessions/${repeated.session.id}/days/${uploadBody.day.id}/cards` })).json();
    assert.ok(repeatedList.cards.every((card: { status: string }) => card.status === "unseen"));
    assert.ok((await inject({ method: "GET", url: listUrl })).json().cards.every((card: { status: string }) => card.status === "known"));

    const day2Response = await inject(multipartRequest("day2.csv", "word,meaning\nsecond,둘째\n"));
    const day3Response = await inject(multipartRequest("day3.csv", "word,meaning\nthird-a,셋째 A\nthird-b,셋째 B\n"));
    assert.equal(day2Response.statusCode, 201);
    assert.equal(day3Response.statusCode, 201);
    const day3 = day3Response.json() as { day: { id: string } };

    const grouped = await inject({ method: "POST", url: "/api/study/sessions", payload: { targetDayId: day3.day.id } });
    const groupedBody = grouped.json() as { session: { id: string }; cards: Array<{ id: string }> };
    assert.equal(grouped.statusCode, 201);
    assert.equal(groupedBody.cards.length, 3);
    const excludedDay = (await inject({ method: "GET", url: `/api/study/sessions/${groupedBody.session.id}/days/${uploadBody.day.id}/cards` })).json();
    assert.equal(excludedDay.cards.length, 2);
    assert.ok(excludedDay.cards.every((card: { status: string }) => card.status === "not_in_session"));

    for (const [index, card] of groupedBody.cards.entries()) {
      const attempt = await inject({
        method: "POST",
        url: `/api/study/sessions/${groupedBody.session.id}/attempts`,
        payload: {
          idempotencyKey: crypto.randomUUID(), cardId: card.id, roundNumber: 1, position: index + 1,
          result: "unknown", responseMs: 100, revealedAtMs: 50,
        },
      });
      assert.equal(attempt.statusCode, 200);
    }

    const groupedRound = await inject({ method: "POST", url: `/api/study/sessions/${groupedBody.session.id}/rounds` });
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

test("imports headerless xlsx row 1 and keeps existing rows and positive-row validation", { timeout: 20_000 }, async () => {
  const sql = createDatabase(databaseUrl);
  await applyMigrations(sql);
  await applyMigrations(sql); // Already-applied migrations must be safe to run again.
  await sql.unsafe("TRUNCATE jobs, users CASCADE");
  const app = buildApp(sql, undefined, testConfig);
  const cookie = await loginOwner(app, sql);
  const inject = (options: import("fastify").InjectOptions) => app.inject({ ...options, headers: { cookie, origin: testConfig.origin, ...options.headers } });
  try {
    const original = await inject(multipartRequest("header.csv", "word,meaning\nsteady,꾸준한\n"));
    assert.equal(original.statusCode, 201);
    const originalId = original.json().day.id as string;
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["resume", "이력서"], ["vacancy", "공석"]]), "Words");
    const uploaded = await inject(multipartRequest("headerless.xlsx", XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })));
    assert.equal(uploaded.statusCode, 201);
    const dayId = uploaded.json().day.id as string;
    const cards = await sql<{ source_row: number; term: string }[]>`SELECT source_row, term FROM cards WHERE day_id = ${dayId} ORDER BY source_row`;
    assert.deepEqual(Array.from(cards), [{ source_row: 1, term: "resume" }, { source_row: 2, term: "vacancy" }]);
    const originalCards = await sql<{ source_row: number }[]>`SELECT source_row FROM cards WHERE day_id = ${originalId}`;
    assert.equal(originalCards[0]!.source_row, 2);
    const jobs = await sql<{ count: string }[]>`SELECT count(*) FROM jobs WHERE status = 'queued'`;
    assert.equal(Number(jobs[0]!.count), 3);
    await assert.rejects(sql`UPDATE cards SET source_row = 0 WHERE day_id = ${originalId}`, { code: "23514", constraint_name: "cards_source_row_check" });
  } finally { await app.close(); }
});

function multipartRequest(filename: string, content: string | Buffer) {
  const boundary = "chanvoca-test-boundary";
  return {
    method: "POST" as const,
    url: "/api/days/upload",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.isBuffer(content) ? content : Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
