let reportCount = 0;
let reportWindow = 0;
async function report(event, error, level = error ? "error" : "info") {
  if (Date.now() - reportWindow > 60_000) { reportCount = 0; reportWindow = Date.now(); }
  if (++reportCount > 30) return;
  const entry = { level, event, stage: "service_worker" };
  if (error instanceof Error) {
    entry.errorType = error.name;
    entry.stack = [...(error.stack ?? "").matchAll(/([a-zA-Z0-9_.-]+\.js):(\d+):(\d+)/g)]
      .slice(0, 5).map((match) => `${match[1].slice(-128)}:${match[2]}:${match[3]}`).join("\n");
  }
  console.log(JSON.stringify(entry));
  try {
    await fetch("/api/client-logs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([entry]), signal: AbortSignal.timeout(5000) });
  } catch { /* Offline reporting is best effort. */ }
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try {
      payload = event.data?.json() ?? {};
    } catch (error) {
      await report("pwa.payload_invalid", error, "warn");
      payload = { body: event.data?.text() };
    }
    await self.registration.showNotification(payload.title ?? "오늘의 단어를 복습할 시간이에요", {
      body: payload.body ?? "오늘 계획을 열어 학습을 시작하세요.",
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url: payload.url ?? "/?source=notification" },
    });
    await report("pwa.notification_shown");
  })().catch(async (error) => {
    await report("pwa.notification_failed", error);
    throw error;
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.waitUntil((async () => {
    event.notification.close();
    const requested = new URL(event.notification.data?.url ?? "/", self.location.origin);
    const target = requested.origin === self.location.origin ? requested.href : self.location.origin;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => client.url === target);
    const opened = await (existing ? existing.focus() : self.clients.openWindow(target));
    await report(opened ? "pwa.notification_opened" : "pwa.notification_open_blocked", undefined, opened ? "info" : "warn");
  })().catch(async (error) => {
    await report("pwa.notification_open_failed", error);
    throw error;
  }));
});
