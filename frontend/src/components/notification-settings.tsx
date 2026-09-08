"use client";

import { useEffect, useState } from "react";

import { api, messageFrom } from "@/lib/api";
import { clientLog, reportError } from "@/lib/client-log";

type Settings = {
  enabled: boolean;
  localTime: string | null;
  timezone: string;
  activeSubscriptions: number;
};

type PushConfig = { publicKey: string };

export function NotificationSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [supported, setSupported] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [localTime, setLocalTime] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const initId = window.setTimeout(() => {
      setSupported("serviceWorker" in navigator && "PushManager" in window && "Notification" in window);
      setInstalled(window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
      void api<Settings>("/api/notification-settings")
        .then((data) => {
          setSettings(data);
          setLocalTime(data.localTime ?? "");
        })
        .catch((error) => { reportError("notifications.load_failed", error); setMessage(messageFrom(error)); });
    }, 0);
    return () => window.clearTimeout(initId);
  }, []);

  const subscribe = async () => {
    if (!supported) return;

    setBusy(true);
    setMessage("");
    try {
      const { publicKey } = await api<PushConfig>("/api/push/config");
      clientLog("info", "notifications.permission_requested");
      const permission = await Notification.requestPermission();
      clientLog(permission === "granted" ? "info" : "warn", "notifications.permission_result", { permission });
      if (permission !== "granted") {
        setMessage(permission === "denied" ? "브라우저 설정에서 알림 권한을 허용해 주세요." : "알림 권한이 허용되지 않았습니다.");
        return;
      }

      clientLog("info", "notifications.worker_wait_started");
      const registration = await navigator.serviceWorker.ready;
      clientLog("info", "notifications.worker_ready");
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(publicKey),
      });
      clientLog("info", "notifications.browser_subscribed");
      await api("/api/push/subscriptions", { method: "POST", body: JSON.stringify(subscription.toJSON()) });
      const next = await api<Settings>("/api/notification-settings");
      setSettings(next);
      setLocalTime(next.localTime ?? localTime);
      setMessage("이 기기에 알림 권한이 연결되었습니다.");
    } catch (error) {
      reportError("notifications.subscribe_failed", error);
      setMessage(messageFrom(error));
    } finally {
      setBusy(false);
    }
  };

  const save = async (enabled: boolean) => {
    if (!settings || !localTime) {
      setMessage("알림 시간을 먼저 선택해 주세요.");
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      const next = await api<Settings>("/api/notification-settings", {
        method: "PUT",
        body: JSON.stringify({ enabled, localTime, timezone: settings.timezone }),
      });
      clientLog("info", "notifications.settings_saved");
      setSettings({ ...settings, ...next });
      setMessage(enabled ? "매일 학습 알림을 켰습니다." : "매일 학습 알림을 껐습니다.");
    } catch (error) {
      reportError("notifications.save_failed", error);
      setMessage(messageFrom(error));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    setMessage("");
    try {
      await api("/api/push/test", { method: "POST" });
      clientLog("info", "notifications.test_queued");
      setMessage("테스트 알림을 작업 큐에 넣었습니다.");
    } catch (error) {
      reportError("notifications.test_failed", error);
      setMessage(messageFrom(error));
    } finally {
      setBusy(false);
    }
  };

  if (!supported) return <section className="menu-section"><h3>매일 학습 알림</h3><p className="helper-text">이 브라우저에서는 푸시 알림을 지원하지 않습니다.</p></section>;

  return (
    <section className="menu-section notification-section">
      <h3>매일 학습 알림</h3>
      {!installed && <p className="helper-text">iPhone/iPad에서는 먼저 홈 화면에 앱을 추가한 뒤 알림을 켤 수 있습니다.</p>}
      <label className="time-control">알림 시간<input type="time" value={localTime} onChange={(event) => setLocalTime(event.target.value)} disabled={busy} /></label>
      {settings?.activeSubscriptions ? (
        <div className="notification-actions">
          <button className="ghost-action" type="button" disabled={busy} onClick={() => void save(!settings.enabled)}>{settings.enabled ? "알림 끄기" : "알림 켜기"}</button>
          <button className="ghost-action" type="button" disabled={busy} onClick={() => void sendTest()}>테스트</button>
        </div>
      ) : <button className="ghost-action" type="button" disabled={busy} onClick={() => void subscribe()}>이 기기에 알림 허용</button>}
      {message && <p className="helper-text notification-message">{message}</p>}
    </section>
  );
}

function base64UrlToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
