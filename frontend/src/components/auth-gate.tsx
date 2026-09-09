"use client";

import { FormEvent, useEffect, useState } from "react";

import { StudyApp } from "@/components/study-app";
import { api, messageFrom } from "@/lib/api";
import { clientLog, reportError } from "@/lib/client-log";

type State = "checking" | "signed-out" | "signed-in";

export function AuthGate() {
  const [state, setState] = useState<State>("checking");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void fetch("/api/auth/session", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ authenticated: boolean }> : { authenticated: false })
      .then(({ authenticated }) => { clientLog("info", "auth.session_loaded", { authenticated }); setState(authenticated ? "signed-in" : "signed-out"); })
      .catch((cause) => { reportError("auth.session_failed", cause); setError("로그인 상태를 확인하지 못했습니다."); setState("signed-out"); });
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      clientLog("info", "auth.login_completed");
      setPassword("");
      setState("signed-in");
    } catch (cause) {
      reportError("auth.login_failed", cause);
      setError(messageFrom(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const logout = async () => {
    try { await api("/api/auth/logout", { method: "POST" }); }
    catch (cause) { reportError("auth.logout_failed", cause); }
    clientLog("info", "auth.logout_completed");
    window.localStorage.removeItem("chanvoca:active-session");
    setState("signed-out");
  };

  if (state === "signed-in") return <StudyApp onLogout={() => void logout()} />;
  if (state === "checking") return <main className="auth-stage"><p>로그인 상태를 확인하고 있어요.</p></main>;
  return <main className="auth-stage"><form className="auth-card" onSubmit={(event) => void submit(event)}><span className="eyebrow">CHANVOCA</span><h1>로그인</h1><p>개인 단어장을 열려면 비밀번호를 입력하세요.</p><label>비밀번호<input type="password" value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} required autoFocus /></label>{error && <p className="auth-error" role="alert">{error}</p>}<button className="primary-action" type="submit" disabled={submitting}>{submitting ? "확인 중…" : "로그인"}</button></form></main>;
}
