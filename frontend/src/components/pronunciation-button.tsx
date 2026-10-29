"use client";

import { useEffect, useRef, useState } from "react";
import { createPronunciation, selectEnglishVoice } from "@/lib/pronunciation";

export function PronunciationButton({ term }: { term: string }) {
  const [availability, setAvailability] = useState<"loading" | "ready" | "unsupported" | "missing">("loading");
  const [speaking, setSpeaking] = useState(false);
  const [message, setMessage] = useState("");
  const player = useRef<ReturnType<typeof createPronunciation> | null>(null);
  useEffect(() => {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      const timer = globalThis.setTimeout(() => setAvailability("unsupported"), 0);
      return () => globalThis.clearTimeout(timer);
    }
    let mounted = true;
    const synth = window.speechSynthesis;
    const refresh = () => {
      const voices = synth.getVoices();
      setAvailability(selectEnglishVoice(voices) ? "ready" : voices.length ? "missing" : "loading");
    };
    const instance = createPronunciation(synth, (text) => new SpeechSynthesisUtterance(text), (active, error) => {
      if (mounted) { setSpeaking(active); setMessage(error); }
    });
    player.current = instance;
    const timer = globalThis.setTimeout(refresh, 0);
    synth.addEventListener("voiceschanged", refresh);
    const hidden = () => { if (document.hidden) instance.stop(); };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      mounted = false;
      globalThis.clearTimeout(timer);
      instance.stop();
      player.current = null;
      synth.removeEventListener("voiceschanged", refresh);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  const unavailable = availability === "unsupported" || availability === "missing";
  const notice = availability === "unsupported" ? "이 기기에서는 발음 듣기를 지원하지 않아요." : availability === "missing" ? "미국 영어 음성을 사용할 수 없어요. 기기의 음성 설정을 확인해 주세요." : message;
  return <div className="pronunciation">
    <button type="button" disabled={unavailable} aria-label={`${term} 발음 듣기`} onClick={(event) => { event.stopPropagation(); player.current?.play(term); }} onKeyDown={(event) => event.stopPropagation()}>
      <span aria-hidden="true">🔊</span> {speaking ? "다시 듣기" : "발음 듣기"}
    </button>
    <p role="status">{notice}</p>
  </div>;
}
