import { processPushJob } from "./notifications.worker.js";
import type { Database } from "../../shared/db.js";
import { isPushEndpoint } from "./push-endpoint.js";
import assert from "node:assert/strict";
import test from "node:test";

import { localClock } from "./notifications.worker.js";

test("calculates a local notification minute in Asia/Seoul", () => {
  assert.deepEqual(localClock(new Date("2026-09-02T12:34:00.000Z"), "Asia/Seoul"), {
    date: "2026-09-02",
    time: "21:34",
  });
});

test("push endpoints accept providers and reject internal or lookalike hosts", () => {
  for (const endpoint of ["https://fcm.googleapis.com/fcm/send/test", "https://web.push.apple.com/test", "https://updates.push.services.mozilla.com/test", "https://wns2.example.notify.windows.com/test"]) assert.equal(isPushEndpoint(endpoint), true);
  for (const endpoint of ["https://127.0.0.1/test", "http://fcm.googleapis.com/test", "https://fcm.googleapis.com.evil.test", "https://user:pass@fcm.googleapis.com/test", "https://fcm.googleapis.com:444/test", null]) assert.equal(isPushEndpoint(endpoint), false);
});

test("legacy and malformed push jobs are discarded before querying or sending", async () => {
  const sql = (() => { throw new Error("Malformed jobs must not query the database."); }) as unknown as Database;
  for (const payload of [null, {}, { subscriptionId: "old", title: "old", body: "old", url: "/" }, { subscriptionId: "invalid", userId: "invalid", authSessionId: "invalid", title: "test", body: "test", url: "/" }]) assert.deepEqual(await processPushJob(sql, payload), { completed: true });
});
