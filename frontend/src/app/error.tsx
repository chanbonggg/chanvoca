"use client";

import { useEffect } from "react";
import { reportError } from "@/lib/client-log";

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => { reportError("render.failed", error, { stage: "app.error" }); }, [error]);
  return <main><h2>화면을 표시하지 못했습니다.</h2><button onClick={retry}>다시 시도</button></main>;
}
