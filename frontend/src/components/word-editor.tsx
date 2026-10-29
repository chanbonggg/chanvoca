"use client";

import { useRef, useState } from "react";
import { api, messageFrom } from "@/lib/api";

export type EditedWord = { id: string; term: string; meaning: string };

export function WordEditor({ dayId, card, onSaved }: { dayId: string; card: EditedWord; onSaved: (card: EditedWord) => void }) {
  const [editing, setEditing] = useState(false);
  const [term, setTerm] = useState(card.term);
  const [meaning, setMeaning] = useState(card.meaning);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const finish = () => { setEditing(false); window.requestAnimationFrame(() => trigger.current?.focus()); };
  return <div className="word-editor">
    <button ref={trigger} className="ghost-action" type="button" hidden={editing} aria-label={`${card.term} 수정`} onClick={() => { setTerm(card.term); setMeaning(card.meaning); setError(""); setEditing(true); }}>수정</button>
    {editing && <form onSubmit={async (event) => {
      event.preventDefault();
      if (pending.current) return;
      if (!term.trim() || !meaning.trim()) { setError("단어와 뜻을 모두 입력하세요."); return; }
      pending.current = true; setSaving(true); setError("");
      try {
        const result = await api<{ card: EditedWord }>(`/api/days/${dayId}/cards/${card.id}`, { method: "PATCH", body: JSON.stringify({ term: term.trim(), meaning: meaning.trim() }) });
        onSaved(result.card); finish();
      } catch (cause) { setError(messageFrom(cause)); }
      finally { pending.current = false; setSaving(false); }
    }}>
      <label>영어 단어<input autoFocus required maxLength={200} value={term} disabled={saving} onChange={(event) => setTerm(event.target.value)} /></label>
      <label>뜻<input required maxLength={1000} value={meaning} disabled={saving} onChange={(event) => setMeaning(event.target.value)} /></label>
      <p className="helper-text">기존 예문은 바뀌지 않아 수정한 단어·뜻과 다를 수 있어요.</p>
      {error && <p role="alert">{error}</p>}
      <button className="ghost-action" type="submit" disabled={saving || (term.trim() === card.term && meaning.trim() === card.meaning)}>{saving ? "저장 중…" : "저장"}</button>
      <button className="ghost-action" type="button" disabled={saving} onClick={finish}>취소</button>
    </form>}
  </div>;
}
