import { vi } from "vitest";

/** Test-only helpers for code that calls OpenRouter. Not imported by app code. */

export const TEST_ENV = {
  SUPABASE_SECRET_KEY: "test-secret",
  OPENROUTER_API_KEY: "test-openrouter-key",
  OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
  OPENROUTER_MODEL_CV_PARSE: "test/cv-parse-model",
  OPENROUTER_MODEL_CV_VISION: "test/cv-vision-model",
  OPENROUTER_MODEL_EMBED: "test/embed-model",
} as const;

export function stubAiEnv(): void {
  for (const [k, v] of Object.entries(TEST_ENV)) vi.stubEnv(k, v);
}

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> & {
    model?: string;
    temperature?: number;
    messages?: { role: string; content: unknown }[];
  };
}

type Reply = { status?: number; json?: unknown; text?: string };

/** A chat completion response whose message content is `content`. */
export function chatReply(content: string, model = "provider/actual-model"): Reply {
  return { json: { id: "gen-1", model, choices: [{ message: { role: "assistant", content } }] } };
}

/**
 * Stubs global fetch with a queue of replies (the last one repeats) and records every request.
 */
export function mockFetch(...replies: Reply[]) {
  const requests: RecordedRequest[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    const r = replies[Math.min(i++, replies.length - 1)];
    const body = r.text ?? JSON.stringify(r.json ?? {});
    return new Response(body, {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, requests };
}
