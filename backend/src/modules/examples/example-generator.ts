import { currentLog, setStage } from "../../shared/logger.js";

type Example = { exampleEn: string; exampleKo: string };

type GroqResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
};

export class ExampleGenerationError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
  }
}

export async function generateExample(term: string, meaning: string): Promise<Example> {
  setStage("groq.configuration");
  const apiKey = requiredEnv("GROQ_API_KEY");
  const model = requiredEnv("GROQ_MODEL");
  setStage("groq.request");
  const started = performance.now();
  currentLog().debug({ event: "groq.started" }, "Groq request started");
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      max_completion_tokens: 180,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Return JSON only with exactly exampleEn and exampleKo. Write one short, natural English sentence using the requested meaning. The supplied Korean meaning has priority when the word is ambiguous. exampleKo must be its natural Korean translation. Do not add explanations.",
        },
        {
          role: "user",
          content: JSON.stringify({ term, meaning }),
        },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });

  currentLog().info({ event: "groq.response", statusCode: response.status, durationMs: performance.now() - started }, "Groq response headers received");
  if (!response.ok) {
    throw new ExampleGenerationError(
      response.status === 401 || response.status === 403 ? "GROQ_AUTH" : `GROQ_HTTP_${response.status}`,
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }

  setStage("groq.decode_response");
  const payload = await response.json() as GroqResponse;
  const content = payload.choices?.[0]?.message?.content;

  if (!content) throw new ExampleGenerationError("GROQ_EMPTY_RESPONSE", true);

  setStage("groq.validate_example");
  const example = parseExample(content);
  currentLog().info({ event: "groq.completed", durationMs: performance.now() - started }, "Groq example validated");
  return example;
}

export function parseExample(content: string): Example {
  let value: unknown;

  try {
    value = JSON.parse(content);
  } catch {
    throw new ExampleGenerationError("GROQ_INVALID_JSON", true);
  }

  if (!isExample(value)) throw new ExampleGenerationError("GROQ_INVALID_EXAMPLE", true);

  return {
    exampleEn: value.exampleEn.trim(),
    exampleKo: value.exampleKo.trim(),
  };
}

function isExample(value: unknown): value is Example {
  if (!value || typeof value !== "object") return false;

  const { exampleEn, exampleKo } = value as Record<string, unknown>;
  return typeof exampleEn === "string" && exampleEn.trim().length > 0 && exampleEn.length <= 500 &&
    typeof exampleKo === "string" && exampleKo.trim().length > 0 && exampleKo.length <= 1_000;
}

function requiredEnv(name: "GROQ_API_KEY" | "GROQ_MODEL") {
  const value = process.env[name]?.trim();
  if (!value) throw new ExampleGenerationError(`MISSING_${name}`, false);
  return value;
}
