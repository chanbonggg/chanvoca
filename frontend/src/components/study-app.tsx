"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { NotificationSettings } from "@/components/notification-settings";
import { api, messageFrom } from "@/lib/api";
import { clientLog, reportError } from "@/lib/client-log";

type ExampleStatus = "pending" | "processing" | "ready" | "failed";
type Result = "known" | "unknown" | "timeout";

type Day = {
  id: string;
  dayNumber: number;
  originalFilename: string;
  rowCount: number;
  importedAt: string;
  examples: Record<ExampleStatus, number>;
};

type Card = {
  id: string;
  term: string;
  meaning: string;
  exampleEn: string | null;
  exampleKo: string | null;
  exampleStatus: ExampleStatus;
};

type Session = {
  id: string;
  targetDayId: string;
  targetDayNumber: number;
  planDayNumbers: number[];
  status: "in_progress" | "completed" | "abandoned";
  totalCards: number;
  knownCount: number;
  unknownCount: number;
  timeoutCount: number;
  roundsCompleted: number;
  repeatOfSessionId: string | null;
};

type SessionResponse = {
  session: Session;
  roundNumber: number;
  cards: Card[];
  roundComplete?: boolean;
};

type Phase = "loading" | "empty" | "studying" | "complete" | "error";

const activeSessionKey = "chanvoca:active-session";

export function StudyApp({ onLogout }: { onLogout: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [days, setDays] = useState<Day[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [session, setSession] = useState<Session | null>(null);
  const [roundNumber, setRoundNumber] = useState(1);
  const [cards, setCards] = useState<Card[]>([]);
  const [cardIndex, setCardIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(10);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const startedAtRef = useRef(0);
  const revealedAtRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  const currentCard = cards[cardIndex] ?? null;

  const applySession = useCallback((data: SessionResponse) => {
    clientLog("info", "study.session_applied", { sessionId: data.session.id, roundNumber: data.roundNumber, count: data.cards.length });
    setSession(data.session);
    setRoundNumber(data.roundNumber);
    setCards(data.cards);
    setCardIndex(0);
    setRevealed(false);
    setTimedOut(false);
    setRemainingSeconds(10);
  }, []);

  const advanceRound = useCallback(async (sessionId: string) => {
    const data = await api<{ completed: boolean } & SessionResponse>(`/api/study/sessions/${sessionId}/rounds`, {
      method: "POST",
    });

    clientLog("info", "study.round_advanced", { sessionId, roundNumber: data.roundNumber });
    if (data.completed) {
      setSession(data.session);
      setCards([]);
      setPhase("complete");
      window.localStorage.removeItem(activeSessionKey);
      return;
    }

    applySession(data);
  }, [applySession]);

  const loadSession = useCallback(async (sessionId: string) => {
    clientLog("info", "study.resume_started", { sessionId });
    const data = await api<SessionResponse>(`/api/study/sessions/${sessionId}`);

    if (data.session.status === "completed") {
      setSession(data.session);
      setPhase("complete");
      window.localStorage.removeItem(activeSessionKey);
      return;
    }

    applySession(data);
    setPhase("studying");

    if (data.roundComplete) await advanceRound(data.session.id);
  }, [advanceRound, applySession]);

  const startSession = useCallback(async (targetDayId?: string, repeatOfSessionId?: string) => {
    setPhase("loading");
    setErrorMessage("");

    try {
      const data = await api<SessionResponse>("/api/study/sessions", {
        method: "POST",
        body: JSON.stringify(targetDayId ? { targetDayId } : { repeatOfSessionId }),
      });
      applySession(data);
      window.localStorage.setItem(activeSessionKey, data.session.id);
      setPhase("studying");
    } catch (error) {
      reportError("study.start_failed", error, { stage: "study.start" });
      setErrorMessage(messageFrom(error));
      setPhase("error");
    }
  }, [applySession]);

  const loadDays = useCallback(async () => {
    setPhase("loading");
    setErrorMessage("");

    try {
      const data = await api<{ days: Day[] }>("/api/days");
      clientLog("info", "study.days_loaded", { count: data.days.length });
      setDays(data.days);

      if (data.days.length === 0) {
        setPhase("empty");
        return;
      }

      const fromNotification = new URLSearchParams(window.location.search).get("source") === "notification";
      if (fromNotification) window.history.replaceState(null, "", window.location.pathname);
      const savedSessionId = fromNotification ? null : window.localStorage.getItem(activeSessionKey);
      if (savedSessionId) {
        try {
          await loadSession(savedSessionId);
          return;
        } catch (error) {
          reportError("study.resume_failed", error, { sessionId: savedSessionId });
          window.localStorage.removeItem(activeSessionKey);
        }
      }

      await startSession(data.days[0]!.id);
    } catch (error) {
      reportError("study.load_failed", error, { stage: "study.load" });
      setErrorMessage(messageFrom(error));
      setPhase("error");
    }
  }, [loadSession, startSession]);

  const submitResult = useCallback(async (result: Result) => {
    if (!session || !currentCard || savingRef.current) return;

    savingRef.current = true;
    setSaving(true);

    try {
      await api(`/api/study/sessions/${session.id}/attempts`, {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          cardId: currentCard.id,
          roundNumber,
          position: cardIndex + 1,
          result,
          responseMs: Math.max(0, Math.round(performance.now() - startedAtRef.current)),
          revealedAtMs: result === "timeout" ? null : revealedAtRef.current,
        }),
      });

      setSession((current) => {
        if (!current || current.id !== session.id) return current;
        return {
          ...current,
          knownCount: current.knownCount + (result === "known" ? 1 : 0),
          unknownCount: current.unknownCount + (result === "unknown" ? 1 : 0),
          timeoutCount: current.timeoutCount + (result === "timeout" ? 1 : 0),
        };
      });
      clientLog("info", "study.attempt_saved", { sessionId: session.id, cardId: currentCard.id, roundNumber });
      if (cardIndex + 1 < cards.length) {
        setCardIndex((value) => value + 1);
        setRevealed(false);
        setTimedOut(false);
        setRemainingSeconds(10);
      } else {
        await advanceRound(session.id);
      }
    } catch (error) {
      reportError("study.attempt_failed", error, { stage: "study.attempt" });
      setErrorMessage(messageFrom(error));
      setPhase("error");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [advanceRound, cardIndex, cards.length, currentCard, roundNumber, session]);

  useEffect(() => {
    const loadId = window.setTimeout(() => void loadDays(), 0);
    return () => window.clearTimeout(loadId);
  }, [loadDays]);

  useEffect(() => {
    if (!menuOpen) return;

    const drawer = drawerRef.current;
    const trigger = menuButtonRef.current;
    if (!drawer) return;
    const focusable = () => Array.from(drawer.querySelectorAll<HTMLElement>("button, input, [tabindex]:not([tabindex='-1'])"))
      .filter((element) => !element.hasAttribute("disabled"));
    const first = focusable()[0];
    const focusId = window.requestAnimationFrame(() => first?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") return setMenuOpen(false);
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1)?.focus(); }
      if (!event.shiftKey && index === items.length - 1) { event.preventDefault(); items[0]?.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusId);
      document.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [menuOpen]);

  useEffect(() => {
    if (phase !== "studying" || !currentCard || revealed || timedOut) return;

    const startedAt = performance.now();
    startedAtRef.current = startedAt;
    revealedAtRef.current = null;
    const expire = () => {
      clientLog("debug", "study.card_timeout", { cardId: currentCard.id });
      setRemainingSeconds(0);
      setTimedOut(true);
      setRevealed(true);
    };

    const intervalId = window.setInterval(() => {
      setRemainingSeconds(Math.max(0, Math.ceil((startedAt + 10_000 - performance.now()) / 1_000)));
    }, 100);
    const timeoutId = window.setTimeout(expire, 10_000);
    const onVisibilityChange = () => {
      if (!document.hidden && performance.now() >= startedAt + 10_000) expire();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [currentCard, phase, revealed, submitResult, timedOut]);

  useEffect(() => {
    if (!timedOut) return;

    const timeoutId = window.setTimeout(() => void submitResult("timeout"), 1_200);
    return () => window.clearTimeout(timeoutId);
  }, [submitResult, timedOut]);

  const reveal = () => {
    if (!currentCard || revealed || timedOut || saving) return;
    clientLog("debug", "study.card_revealed", { cardId: currentCard.id });
    revealedAtRef.current = Math.max(0, Math.round(performance.now() - startedAtRef.current));
    setRevealed(true);
  };

  const selectDay = async (dayId: string) => {
    setMenuOpen(false);
    await startSession(dayId);
  };

  const uploadFile = async (file: File | undefined) => {
    if (!file || uploading) return;

    clientLog("info", "upload.started", { bytes: file.size, format: ["xlsx", "xls", "csv"].find((format) => file.name.toLowerCase().endsWith(`.${format}`)) ?? "unsupported" });
    setUploading(true);
    setUploadMessage("");
    try {
      const formData = new FormData();
      formData.set("file", file);
      const data = await api<{ day?: Day }>("/api/days/upload", { method: "POST", body: formData });
      if (!data.day) throw new Error("새 Day 정보를 받지 못했습니다.");

      clientLog("info", "upload.completed", { dayId: data.day.id, rowCount: data.day.rowCount });
      setDays((current) => [data.day!, ...current]);
      window.localStorage.removeItem(activeSessionKey);
      setMenuOpen(false);
      await startSession(data.day.id);
    } catch (error) {
      reportError("upload.failed", error, { stage: "upload.failed" });
      setUploadMessage(messageFrom(error));
    } finally {
      setUploading(false);
    }
  };

  const repeatAll = async () => {
    if (session) await startSession(undefined, session.id);
  };

  const progress = session ? Math.round((session.knownCount / session.totalCards) * 100) : 0;
  const activeDay = session?.targetDayNumber ?? days[0]?.dayNumber;

  return (
    <main className="app-stage">
      <section className="app-shell" aria-label="영단어 학습 앱">
        <header className="top-bar">
          <button ref={menuButtonRef} className="icon-button" type="button" aria-label="메뉴 열기" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><span aria-hidden="true">☰</span></button>
          <div className="day-label"><span className="eyebrow">{phase === "complete" ? "COMPLETE" : "TODAY"}</span><strong>{activeDay ? `Day ${activeDay}` : "Day —"}</strong></div>
          <div className="session-stats" aria-label="학습 상태"><span>{session ? `${session.knownCount} / ${session.totalCards}` : "0 / 0"}</span><strong>{revealed ? "—" : `${remainingSeconds}s`}</strong></div>
        </header>

        <div className="progress-track" aria-label={`진행률 ${progress}%`}><span style={{ width: `${progress}%` }} /></div>

        <section className="study-area" aria-live="polite">
          {phase === "loading" && <LoadingCard />}
          {phase === "empty" && <EmptyCard onOpenMenu={() => setMenuOpen(true)} />}
          {phase === "error" && <ErrorCard message={errorMessage} onRetry={() => void loadDays()} />}
          {phase === "complete" && session && <CompleteCard session={session} onRepeat={() => void repeatAll()} />}
          {phase === "studying" && currentCard && (
            <article className={`word-card study-card ${revealed ? "is-revealed" : ""}`} role="button" tabIndex={revealed ? -1 : 0} aria-label={revealed ? "뜻을 확인했습니다" : "카드를 눌러 뜻 보기"} onClick={reveal} onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); reveal(); }
            }}>
              <span className="card-kicker">ROUND {roundNumber} · {cardIndex + 1} / {cards.length}</span>
              <h1 className="term">{currentCard.term}</h1>
              {!revealed && <p className="tap-hint">카드를 눌러 뜻을 확인하세요</p>}
              {revealed && <div className="card-back">
                <p className="meaning">{currentCard.meaning}</p>
                {currentCard.exampleStatus === "ready" && currentCard.exampleEn && currentCard.exampleKo ? <div className="example"><p>{currentCard.exampleEn}</p><small>{currentCard.exampleKo}</small></div> : <p className="example-status">{currentCard.exampleStatus === "failed" ? "예문 없음" : "예문 생성 중"}</p>}
                {timedOut && <p className="timeout-note">시간이 지나 자동으로 ‘몰랐어요’ 처리됩니다.</p>}
              </div>}
            </article>
          )}
        </section>

        <footer className="answer-bar" aria-label="답변 버튼">
          <button type="button" className="answer-button unknown" disabled={!revealed || timedOut || saving || phase !== "studying"} onClick={() => void submitResult("unknown")}>몰랐어요</button>
          <button type="button" className="answer-button known" disabled={!revealed || timedOut || saving || phase !== "studying"} onClick={() => void submitResult("known")}>알았어요</button>
        </footer>
      </section>

      {menuOpen && <div className="drawer-layer">
        <button className="drawer-scrim" type="button" aria-label="메뉴 닫기" onClick={() => setMenuOpen(false)} />
        <aside ref={drawerRef} className="drawer" aria-label="학습 메뉴">
          <div className="drawer-heading"><div><span className="eyebrow">CHANVOCA</span><h2>학습 메뉴</h2></div><button className="icon-button" type="button" aria-label="메뉴 닫기" onClick={() => setMenuOpen(false)}>×</button></div>
          <section className="menu-section">
            <div className="menu-title-row"><h3>Day 선택</h3><span>{days.length}개</span></div>
            {days.length === 0 ? <p className="empty-note">업로드된 Day가 없습니다.</p> : <div className="day-list">{days.map((day) => <button className={`day-item ${day.id === session?.targetDayId ? "is-active" : ""}`} type="button" key={day.id} onClick={() => void selectDay(day.id)}><span><strong>Day {day.dayNumber}</strong><small>{day.rowCount}개 단어</small></span><small>{day.examples.ready}/{day.rowCount} 예문</small></button>)}</div>}
          </section>
          <section className="menu-section"><h3>단어 가져오기</h3><label className={`upload-control ${uploading ? "is-uploading" : ""}`}><span>{uploading ? "업로드 중…" : "엑셀 또는 CSV 선택"}</span><small>.xlsx, .xls, .csv</small><input type="file" accept=".xlsx,.xls,.csv" disabled={uploading} onChange={(event) => { void uploadFile(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label><p className="helper-text">헤더가 있으면 첫 행의 word/meaning 또는 단어/뜻을 인식해 제외합니다. 헤더 없이 첫 행부터 단어를 입력해도 됩니다. 빈 행은 건너뛰지만 단어 또는 뜻이 비어 있으면 파일 전체가 저장되지 않고 오류 행을 알려드립니다. CSV는 UTF-8만 지원합니다.</p>{uploadMessage && <p className="upload-message" role="alert">{uploadMessage}</p>}</section>
          <NotificationSettings />
          <section className="menu-section"><button className="ghost-action" type="button" onClick={onLogout}>로그아웃</button></section>
        </aside>
      </div>}
    </main>
  );
}

function LoadingCard() {
  return <article className="word-card word-card-empty"><span className="card-kicker">CHANVOCA</span><h1>학습을<br />준비하고 있어요</h1><p>오늘의 누적 복습 계획을 불러오는 중입니다.</p></article>;
}

function EmptyCard({ onOpenMenu }: { onOpenMenu: () => void }) {
  return <article className="word-card word-card-empty"><span className="card-kicker">첫 학습을 준비해볼까요?</span><h1>단어 파일을<br />업로드해 주세요</h1><p>첫 두 열을 영어 단어와 뜻으로 읽어<br />자동으로 Day 1을 만듭니다.</p><button className="primary-action" type="button" onClick={onOpenMenu}>메뉴에서 업로드</button></article>;
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <article className="word-card word-card-empty"><span className="card-kicker">CONNECTION</span><h1>불러오지<br />못했어요</h1><p>{message || "백엔드 연결을 확인해 주세요."}</p><button className="primary-action" type="button" onClick={onRetry}>다시 시도</button></article>;
}

function CompleteCard({ session, onRepeat }: { session: Session; onRepeat: () => void }) {
  return <article className="word-card word-card-empty complete-card"><span className="card-kicker">TODAY&apos;S PLAN PASSED</span><h1>오늘 계획<br />통과!</h1><p>총 {session.totalCards}개 카드 · {session.roundsCompleted}라운드<br />모름 {session.unknownCount}회 · 시간 초과 {session.timeoutCount}회</p><button className="primary-action" type="button" onClick={onRepeat}>전체 다시 반복하기</button></article>;
}
