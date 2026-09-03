import assert from "node:assert/strict";
import test from "node:test";

import { localClock } from "./notifications.worker.js";

test("calculates a local notification minute in Asia/Seoul", () => {
  assert.deepEqual(localClock(new Date("2026-09-02T12:34:00.000Z"), "Asia/Seoul"), {
    date: "2026-09-02",
    time: "21:34",
  });
});
