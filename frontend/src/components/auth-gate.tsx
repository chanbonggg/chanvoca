"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { StudyApp } from "@/components/study-app";
import { api, messageFrom, setApiUser } from "@/lib/api";

type User = { id: string; loginId: string };
type Session = { authenticated: boolean; user: User | null };

export function AuthGate() {
  const [user, setUser] = useState<User | null>(null);
  const current = useRef<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [version, setVersion] = useState(0);
  const [registering, setRegistering] = useState(false);
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const apply = useCallback((next: User | null, force = false) => {
    if (force || current.current?.id !== next?.id) {
      setApiUser(next?.id ?? null);
      current.current = next;
      setUser(next);
      setVersion((value) => value + 1);
    }
    setChecking(false);
  }, []);
  const check = useCallback(async () => {
    try {
      const session = await api<Session>("/api/auth/session", { cache: "no-store" });
      apply(session.authenticated ? session.user : null);
      setError("");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError("로그인 상태를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.");
      setChecking(false);
    }
  }, [apply]);
  useEffect(() => {
    const timer = window.setTimeout(() => void check(), 0);
    const changed = () => { apply(null, true); setChecking(true); void check(); };
    const storage = (event: StorageEvent) => { if (event.key === "chanvoca:auth-change") changed(); };
    window.addEventListener("storage", storage);
    window.addEventListener("chanvoca:auth-required", changed);
    window.addEventListener("focus", check);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("storage", storage);
      window.removeEventListener("chanvoca:auth-required", changed);
      window.removeEventListener("focus", check);
    };
  }, [apply, check]);
  useEffect(() => {
    if (!user || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window) || Notification.permission !== "granted") return;
    let cancelled = false;
    void navigator.serviceWorker.ready.then((registration) => registration.pushManager.getSubscription()).then(async (subscription) => {
      if (!cancelled && subscription) await api("/api/push/subscriptions", { method: "POST", body: JSON.stringify(subscription.toJSON()) });
    }).catch(() => { /* The notification menu provides an explicit retry. */ });
    return () => { cancelled = true; };
  }, [user, version]);
  const broadcast = () => window.localStorage.setItem("chanvoca:auth-change", crypto.randomUUID());
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true); setError("");
    try {
      const session = await api<Session>(registering ? "/api/auth/register" : "/api/auth/login", {
        method: "POST", body: JSON.stringify({ loginId, password, ...(registering ? { inviteCode } : {}) }),
      });
      apply(session.user, true);
      setPassword(""); setInviteCode("");
      window.localStorage.removeItem("chanvoca:active-session");
      broadcast();
    } catch (cause) { setError(messageFrom(cause)); }
    finally { setSubmitting(false); }
  };
  const logout = async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
      apply(null, true);
      window.localStorage.removeItem("chanvoca:active-session");
      broadcast();
    } catch { window.alert("로그아웃하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요."); }
  };
  if (checking) return <main className="auth-stage"><p>로그인 상태를 확인하고 있어요.</p></main>;
  if (user) return <StudyApp key={`${user.id}:${version}`} userId={user.id} loginId={user.loginId} onLogout={() => void logout()} />;
  return <main className="auth-stage"><form className="auth-card" onSubmit={(event) => void submit(event)}>
    <span className="eyebrow">CHANVOCA</span>
    <h1>{registering ? "초대 가입" : "로그인"}</h1>
    <p>{registering ? "초대 코드로 나만의 단어장을 시작하세요." : "내 계정으로 단어장과 학습 기록을 열어보세요."}</p>
    <label>아이디<input value={loginId} onChange={(event) => setLoginId(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={32} required autoFocus /></label>
    <label>비밀번호<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={registering ? "new-password" : "current-password"} required /><small>15~128자, 공백과 한글을 사용할 수 있어요.</small></label>
    {registering && <label>초대 코드<input value={inviteCode} onChange={(event) => setInviteCode(event.target.value.trim())} autoComplete="off" spellCheck={false} required /></label>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    <button className="primary-action" type="submit" disabled={submitting}>{submitting ? "확인 중…" : registering ? "가입하기" : "로그인"}</button>
    <button className="ghost-action" type="button" disabled={submitting} onClick={() => { setRegistering(!registering); setError(""); setPassword(""); }}>{registering ? "로그인으로 돌아가기" : "초대 코드로 가입하기"}</button>
    <p>비밀번호를 잊었다면 운영자에게 재설정을 요청해 주세요.</p>
  </form></main>;
}
