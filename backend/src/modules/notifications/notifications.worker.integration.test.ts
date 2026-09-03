import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase } from "../../shared/db.js";
import { applyMigrations } from "../../shared/migrations.js";
import { getOwnerId } from "../system/owner.js";
import { localClock, scheduleNotifications } from "./notifications.worker.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("schedules one daily push job per subscription", { skip: !databaseUrl, timeout: 20_000 }, async () => {
  const sql = createDatabase(databaseUrl);
  await applyMigrations(sql);
  await sql.unsafe("TRUNCATE jobs, users CASCADE");

  try {
    const ownerId = await getOwnerId(sql);
    const now = new Date("2026-09-03T12:34:00.000Z");
    const local = localClock(now, "Asia/Seoul");
    await sql`
      INSERT INTO push_subscriptions ${sql({
        user_id: ownerId,
        endpoint: "https://push.example.test/subscription",
        p256dh: "test-p256dh",
        auth: "test-auth",
      })}
    `;
    await sql`
      INSERT INTO notification_settings ${sql({
        user_id: ownerId,
        enabled: true,
        local_time: local.time,
        timezone: "Asia/Seoul",
      })}
    `;

    await scheduleNotifications(sql, now);
    await scheduleNotifications(sql, now);

    const jobs = await sql<{ count: string }[]>`
      SELECT count(*) FROM jobs WHERE kind = 'send_push' AND status = 'queued'
    `;
    const settings = await sql<{ last_enqueued_local_date: string }[]>`
      SELECT last_enqueued_local_date::text FROM notification_settings WHERE user_id = ${ownerId}
    `;
    assert.equal(Number(jobs[0]!.count), 1);
    assert.equal(settings[0]!.last_enqueued_local_date, local.date);
  } finally {
    await sql.end();
  }
});
