self.addEventListener("push", (event) => {
  let payload = {};

  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { body: event.data?.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? "오늘의 단어를 복습할 시간이에요", {
      body: payload.body ?? "오늘 계획을 열어 학습을 시작하세요.",
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url: payload.url ?? "/?source=notification" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const requested = new URL(event.notification.data?.url ?? "/", self.location.origin);
  const target = requested.origin === self.location.origin ? requested.href : self.location.origin;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const existing = windows.find((client) => client.url === target);
      return existing ? existing.focus() : self.clients.openWindow(target);
    }),
  );
});

