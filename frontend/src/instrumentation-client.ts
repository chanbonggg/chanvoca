import { clientLog, flushLogs, reportError } from "./lib/client-log";

window.addEventListener("error", (event) => {
  if (event instanceof ErrorEvent) reportError("runtime.error", event.error, { stage: "window.error", ...(event.error ? {} : { stack: `${event.filename}:${event.lineno}:${event.colno}` }) });
  else clientLog("error", "runtime.resource_failed", { stage: "resource.load" });
}, true);
window.addEventListener("unhandledrejection", (event) => reportError("runtime.unhandled_rejection", event.reason));
window.addEventListener("offline", () => clientLog("warn", "network.offline", { online: false }));
window.addEventListener("online", () => clientLog("info", "network.online", { online: true }));
window.addEventListener("pagehide", flushLogs);
clientLog("info", "app.initialized", { online: navigator.onLine });
