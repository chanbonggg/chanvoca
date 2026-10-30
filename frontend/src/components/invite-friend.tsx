"use client";

import { useRef, useState } from "react";
import { api, messageFrom } from "@/lib/api";

export function InviteFriend() {
  const pending = useRef(false);
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [copyMessage, setCopyMessage] = useState("");

  async function create() {
    if (pending.current) return;
    pending.current = true;
    setCreating(true); setError(""); setCopyMessage("");
    try {
      const result = await api<{ inviteCode: string }>("/api/auth/invites", { method: "POST" });
      setCode(result.inviteCode);
    } catch (cause) { setError(messageFrom(cause)); }
    finally { pending.current = false; setCreating(false); }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopyMessage("초대코드를 복사했습니다. 친구에게 보내주세요.");
    } catch { setCopyMessage("자동 복사를 할 수 없습니다. 코드 입력칸을 눌러 직접 복사해 주세요."); }
  }

  return <section className="menu-section">
    <h3>친구 초대</h3>
    <p className="helper-text">코드는 발급 후 7일 동안 한 명만 사용할 수 있어요. 친구가 가입 화면의 ‘초대 코드로 가입하기’에서 입력하면 됩니다.</p>
    <button className="ghost-action" type="button" disabled={creating} onClick={() => void create()}>{creating ? "발급 중…" : code ? "다른 친구 초대코드 만들기" : "친구 초대코드 만들기"}</button>
    {code && <>
      <label>초대코드<input aria-label="초대코드" style={{ width: "100%", minWidth: 0 }} value={code} readOnly autoComplete="off" spellCheck={false} onFocus={(event) => event.currentTarget.select()} /></label>
      <button className="ghost-action" type="button" disabled={creating} onClick={() => void copy()}>초대코드 복사</button>
      <p className="helper-text">메뉴를 닫기 전에 복사해 주세요. 새 코드를 만들어도 이전 코드는 유효합니다.</p>
    </>}
    {error && <p role="alert">{error}</p>}
    <p role="status">{copyMessage}</p>
  </section>;
}
