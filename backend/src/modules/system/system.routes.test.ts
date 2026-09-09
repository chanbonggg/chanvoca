import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../app.js";

test("GET /api/health", async () => {
  const app = buildApp(undefined, undefined, null);
  const response = await app.inject({ method: "GET", url: "/api/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });

  await app.close();
});
