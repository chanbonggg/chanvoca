"use client";

import { useEffect } from "react";
import { clientLog, reportError } from "@/lib/client-log";

export function PwaRegistrar() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      clientLog("info", "pwa.register_started");
      void navigator.serviceWorker.register("/sw.js", { scope: "/" })
        .then(() => clientLog("info", "pwa.registered"))
        .catch((error) => reportError("pwa.register_failed", error));
    }
  }, []);

  return null;
}
