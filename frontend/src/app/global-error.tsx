"use client";

import { useEffect } from "react";
import { reportError } from "@/lib/client-log";

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => { reportError("render.global_failed", error, { stage: "app.layout" }); }, [error]);
  return <html lang="ko"><body><h2>앱을 표시하지 못했습니다.</h2><button onClick={retry}>다시 시도</button></body></html>;
}
