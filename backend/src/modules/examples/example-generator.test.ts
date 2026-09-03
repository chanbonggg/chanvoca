import assert from "node:assert/strict";
import test from "node:test";

import { ExampleGenerationError, parseExample } from "./example-generator.js";

test("parses a valid Groq JSON example", () => {
  assert.deepEqual(parseExample('{"exampleEn":"She remained calm under pressure.","exampleKo":"그녀는 압박 속에서도 침착했다."}'), {
    exampleEn: "She remained calm under pressure.",
    exampleKo: "그녀는 압박 속에서도 침착했다.",
  });
});

test("rejects malformed Groq output", () => {
  assert.throws(() => parseExample('{"exampleEn":"only English"}'), ExampleGenerationError);
});

