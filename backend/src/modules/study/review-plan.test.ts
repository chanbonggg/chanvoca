import assert from "node:assert/strict";
import test from "node:test";

import { reviewDayNumbers, shuffled, shuffledWithinDays } from "./review-plan.js";

test("keeps only existing positive review-day candidates", () => {
  assert.deepEqual(reviewDayNumbers(1), [1]);
  assert.deepEqual(reviewDayNumbers(7), [7, 6, 4, 1]);
  assert.deepEqual(reviewDayNumbers(30), [30, 29, 27, 24, 17, 1]);
});

test("shuffling returns every input item exactly once", () => {
  assert.deepEqual(shuffled(["a", "b", "c"], () => 0), ["b", "c", "a"]);
});

test("re-review keeps Days newest-first while shuffling only within each Day", () => {
  const cards = [
    { day: 1, id: "a" }, { day: 3, id: "b" }, { day: 3, id: "c" }, { day: 1, id: "d" }, { day: 2, id: "e" },
  ];
  assert.deepEqual(shuffledWithinDays(cards, (card) => card.day, () => 0).map((card) => card.id), ["c", "b", "e", "d", "a"]);
});
