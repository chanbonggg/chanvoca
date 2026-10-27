import { isPushEndpoint } from "./push-endpoint.js";
import { setStage } from "../../shared/logger.js";
import type { FastifyInstance } from "fastify";

import type { Database } from "../../shared/db.js";
import { enqueueJob } from "../../shared/jobs.js";
import { requestUser } from "../auth/index.js";

type SubscriptionBody = {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
};

type SettingsBody = {
  enabled?: boolean;
  localTime?: string;
  timezone?: string;
};

type SettingsRow = {
  enabled: boolean;
  local_time: string;
  timezone: string;
};

export async function registerNotificationRoutes(app: FastifyInstance, sql: Database) {
  app.get("/push/config", async (request, reply) => {
    const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
    if (!publicKey) return reply.code(503).send(error("VAPID_NOT_CONFIGURED", "서버의 웹 푸시 공개 키가 설정되지 않았습니다."));
    return { publicKey };
  });

  app.post<{ Body: SubscriptionBody }>("/push/subscriptions", async (request, reply) => {
    const body = request.body ?? {};

    if (!isSubscription(body)) {
      return reply.code(400).send(error("INVALID_PUSH_SUBSCRIPTION", "푸시 구독 정보가 올바르지 않습니다."));
    }

    const userId = requestUser(request).id;
    setStage("push.save_subscription");
    const saved = await sql`
      INSERT INTO push_subscriptions ${sql({
        user_id: userId,
        auth_session_id: requestUser(request).authSessionId,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        user_agent: request.headers["user-agent"]?.slice(0, 500) ?? null,
      })}
      ON CONFLICT (endpoint) DO UPDATE
      SET user_id = EXCLUDED.user_id,
        auth_session_id = EXCLUDED.auth_session_id,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        user_agent = EXCLUDED.user_agent,
        disabled_at = NULL
      WHERE push_subscriptions.user_id = EXCLUDED.user_id
        OR NOT EXISTS (SELECT 1 FROM auth_sessions WHERE id = push_subscriptions.auth_session_id AND revoked_at IS NULL AND expires_at > now())
      RETURNING id
    `;

    if (!saved.length) return reply.code(409).send(error("SUBSCRIPTION_IN_USE", "다른 계정이 사용 중인 구독입니다."));
    request.log.info({ event: "push.subscribed" }, "Push subscription saved");
    return reply.code(201).send({ subscribed: true });
  });

  app.delete<{ Body: { endpoint?: string } }>("/push/subscriptions", async (request, reply) => {
    if (typeof request.body?.endpoint !== "string" || !request.body.endpoint) {
      return reply.code(400).send(error("INVALID_PUSH_SUBSCRIPTION", "구독 endpoint가 필요합니다."));
    }

    const userId = requestUser(request).id;
    setStage("push.disable_subscription");
    await sql`
      UPDATE push_subscriptions
      SET disabled_at = now()
      WHERE endpoint = ${request.body.endpoint}
        AND user_id = ${userId}
    `;
    request.log.info({ event: "push.unsubscribed" }, "Push subscription disabled");
    return reply.code(204).send();
  });

  app.get("/notification-settings", async (request) => {
    const userId = requestUser(request).id;
    setStage("notifications.load_settings");
    const settings = await sql<SettingsRow[]>`
      SELECT enabled, local_time::text, timezone
      FROM notification_settings
      WHERE user_id = ${userId}
    `;
    setStage("push.count_active_subscriptions");
    const activeSubscriptions = await sql<{ count: string }[]>`
      SELECT count(*)
      FROM push_subscriptions
      WHERE user_id = ${userId}
        AND disabled_at IS NULL
        AND EXISTS (SELECT 1 FROM auth_sessions WHERE id = push_subscriptions.auth_session_id AND user_id = push_subscriptions.user_id AND revoked_at IS NULL AND expires_at > now())
    `;
    const setting = settings[0];

    return {
      enabled: setting?.enabled ?? false,
      localTime: setting?.local_time?.slice(0, 5) ?? null,
      timezone: setting?.timezone ?? "Asia/Seoul",
      activeSubscriptions: Number(activeSubscriptions[0]!.count),
    };
  });

  app.put<{ Body: SettingsBody }>("/notification-settings", async (request, reply) => {
    const body = request.body;
    if (typeof body.enabled !== "boolean" || !isTime(body.localTime) || !isTimezone(body.timezone)) {
      return reply.code(400).send(error("INVALID_NOTIFICATION_SETTINGS", "알림 시간 또는 시간대가 올바르지 않습니다."));
    }

    const userId = requestUser(request).id;
    if (body.enabled) {
      setStage("push.check_active_subscriptions");
      const subscriptions = await sql<{ count: string }[]>`
        SELECT count(*)
        FROM push_subscriptions
        WHERE user_id = ${userId}
          AND disabled_at IS NULL
        AND EXISTS (SELECT 1 FROM auth_sessions WHERE id = push_subscriptions.auth_session_id AND user_id = push_subscriptions.user_id AND revoked_at IS NULL AND expires_at > now())
      `;
      if (Number(subscriptions[0]!.count) === 0) {
        return reply.code(409).send(error("PUSH_SUBSCRIPTION_REQUIRED", "알림을 켜려면 먼저 이 기기에서 알림 권한을 허용하세요."));
      }
    }

    setStage("notifications.save_settings");
    await sql`
      INSERT INTO notification_settings ${sql({
        user_id: userId,
        enabled: body.enabled,
        local_time: body.localTime,
        timezone: body.timezone,
      })}
      ON CONFLICT (user_id) DO UPDATE
      SET enabled = EXCLUDED.enabled,
        local_time = EXCLUDED.local_time,
        timezone = EXCLUDED.timezone,
        updated_at = now()
    `;
    request.log.info({ event: "notifications.settings_saved", enabled: body.enabled }, "Notification settings saved");
    return { enabled: body.enabled, localTime: body.localTime, timezone: body.timezone };
  });

  app.post("/push/test", async (request, reply) => {
    const userId = requestUser(request).id;
    setStage("push.load_test_subscriptions");
    const subscriptions = await sql<{ id: string; auth_session_id: string }[]>`
      SELECT id, auth_session_id
      FROM push_subscriptions
      WHERE user_id = ${userId}
        AND disabled_at IS NULL
        AND EXISTS (SELECT 1 FROM auth_sessions WHERE id = push_subscriptions.auth_session_id AND user_id = push_subscriptions.user_id AND revoked_at IS NULL AND expires_at > now())
    `;

    if (subscriptions.length === 0) {
      return reply.code(409).send(error("PUSH_SUBSCRIPTION_REQUIRED", "테스트할 활성 구독이 없습니다."));
    }

    const today = new Date().toISOString().slice(0, 10);
    await Promise.all(subscriptions.map(({ id, auth_session_id }) => enqueueJob(sql, "send_push", `test:${id}:${auth_session_id}:${today}`, {
      subscriptionId: id,
      userId: userId,
      authSessionId: auth_session_id,
      title: "ChanVoca 테스트 알림",
      body: "학습 알림이 정상적으로 설정되었습니다.",
      url: "/?source=notification",
    })));

    request.log.info({ event: "push.test_queued", subscriptionCount: subscriptions.length }, "Test push enqueue requests completed");
    return reply.code(202).send({ queued: subscriptions.length });
  });
}

function isSubscription(value: SubscriptionBody | undefined): value is Required<SubscriptionBody> {
  return Boolean(
    value && isPushEndpoint(value.endpoint) &&
      typeof value.keys?.p256dh === "string" && value.keys.p256dh.length > 0 && value.keys.p256dh.length <= 1024 &&
      typeof value.keys?.auth === "string" && value.keys.auth.length > 0 && value.keys.auth.length <= 1024,
  );
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isTimezone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function error(code: string, message: string) {
  return { error: { code, message } };
}
