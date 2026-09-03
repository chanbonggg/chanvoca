import webpush from "web-push";

import type { Database } from "../../shared/db.js";
import { enqueueJob } from "../../shared/jobs.js";

type PushJobPayload = {
  subscriptionId: string;
  title: string;
  body: string;
  url: string;
};

type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export class PushError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, readonly disableSubscription = false) {
    super(code);
  }
}

export async function processPushJob(sql: Database, payload: unknown) {
  const job = parsePushPayload(payload);
  if (!job) return { completed: true } as const;

  const subscriptions = await sql<PushSubscriptionRow[]>`
    SELECT id, endpoint, p256dh, auth
    FROM push_subscriptions
    WHERE id = ${job.subscriptionId}
      AND disabled_at IS NULL
  `;
  const subscription = subscriptions[0];
  if (!subscription) return { completed: true } as const;

  try {
    configureVapid();
    await webpush.sendNotification({
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    }, JSON.stringify({ title: job.title, body: job.body, url: job.url }));
    await sql`
      UPDATE push_subscriptions
      SET last_success_at = now()
      WHERE id = ${subscription.id}
    `;
    return { completed: true } as const;
  } catch (error) {
    const statusCode = statusCodeFrom(error);
    const failure = new PushError(
      statusCode ? `PUSH_HTTP_${statusCode}` : "PUSH_NETWORK",
      statusCode !== 404 && statusCode !== 410 && statusCode !== 401 && statusCode !== 403,
      statusCode === 404 || statusCode === 410,
    );
    if (failure.disableSubscription) {
      await sql`UPDATE push_subscriptions SET disabled_at = now() WHERE id = ${subscription.id}`;
    }
    return { completed: false, error: failure } as const;
  }
}

export async function scheduleNotifications(sql: Database, now = new Date()) {
  const settings = await sql<{ user_id: string; local_time: string; timezone: string }[]>`
    SELECT user_id, local_time::text, timezone
    FROM notification_settings
    WHERE enabled = true
  `;

  for (const setting of settings) {
    const local = localClock(now, setting.timezone);
    const configuredTime = setting.local_time.slice(0, 5);
    if (local.time !== configuredTime) continue;

    await sql.begin(async (transaction) => {
      const claimed = await transaction<{ user_id: string }[]>`
        UPDATE notification_settings
        SET last_enqueued_local_date = ${local.date}, updated_at = now()
        WHERE user_id = ${setting.user_id}
          AND (last_enqueued_local_date IS NULL OR last_enqueued_local_date <> ${local.date}::date)
        RETURNING user_id
      `;
      if (!claimed[0]) return;

      const subscriptions = await transaction<{ id: string }[]>`
        SELECT id
        FROM push_subscriptions
        WHERE user_id = ${setting.user_id}
          AND disabled_at IS NULL
      `;
      await Promise.all(subscriptions.map(({ id }) => enqueueJob(transaction, "send_push", `daily:${id}:${local.date}`, {
        subscriptionId: id,
        title: "오늘의 단어 복습",
        body: "오늘 계획을 열어 학습을 시작하세요.",
        url: "/?source=notification",
      })));
    });
  }
}

function configureVapid() {
  const subject = process.env.VAPID_SUBJECT?.trim();
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!subject || !publicKey || !privateKey) throw new PushError("MISSING_VAPID_CONFIG", false);
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

function parsePushPayload(value: unknown): PushJobPayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  return typeof payload.subscriptionId === "string" && typeof payload.title === "string" &&
    typeof payload.body === "string" && typeof payload.url === "string"
    ? { subscriptionId: payload.subscriptionId, title: payload.title, body: payload.body, url: payload.url }
    : null;
}

function statusCodeFrom(error: unknown) {
  return error && typeof error === "object" && typeof (error as { statusCode?: unknown }).statusCode === "number"
    ? (error as { statusCode: number }).statusCode
    : null;
}

export function localClock(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { date: `${lookup.year}-${lookup.month}-${lookup.day}`, time: `${lookup.hour}:${lookup.minute}` };
}
