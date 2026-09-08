import type { Instrumentation } from "next";
import { serverLog } from "./lib/server-log";
import { errorFields } from "./lib/log-fields";

export function register() {
  serverLog("info", "server.started", { stage: "next.register" });
}

export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  serverLog("error", "server.request_failed", { ...errorFields(error), method: request.method, route: request.path, stage: context.routeType });
};
