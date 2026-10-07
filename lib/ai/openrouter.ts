import { z } from "zod";
import { serverEnv } from "@/lib/config";

/**
 * OpenRouter client: every LLM call in the platform goes through here.
 *
 * Server only. App code imports from `@/lib/ai` (which carries the `server-only` guard);
 * this file stays importable by Vitest.
 */

export class AiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`OpenRouter request failed with HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "AiHttpError";
  }
}

export class AiOutputError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "AiOutputError";
  }
}

export interface AiFile {
  filename: string;
  mime: string;
  base64: string;
}

export interface ChatJsonOptions<T> {
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  promptVersion: string;
  temperature?: number;
  files?: AiFile[];
}

export interface ChatJsonResult<T> {
  data: T;
  /** The model OpenRouter actually used (falls back to the requested model). */
  model: string;
  promptVersion: string;
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "file"; file: { filename: string; file_data: string } };

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

const RETRY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_ERROR_CHARS = 2000;

/** POSTs JSON to OpenRouter. Retries once after ~1s on 429/5xx or a network error. */
async function postJson(path: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
  const env = serverEnv();
  const url = `${env.OPENROUTER_BASE_URL.replace(/\/+$/, "")}${path}`;
  const init = (): RequestInit => ({
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "Chase Hire",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init());
    } catch (err) {
      if (attempt === 1) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }

    if (res.ok) {
      const json: unknown = await res.json().catch(() => {
        throw new AiHttpError(502, "OpenRouter returned a non-JSON body");
      });
      // OpenRouter can report upstream failures inside a 200 body.
      const error = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      if (error) {
        const status = typeof error.code === "number" ? error.code : 502;
        throw new AiHttpError(status, String(error.message ?? JSON.stringify(error)));
      }
      return json;
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt === 1) {
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    throw new AiHttpError(res.status, await res.text().catch(() => ""));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strips ```json fences; if JSON.parse still fails, falls back to the outermost {...} span. */
export function extractJson(content: string): unknown {
  const fenced = content.match(/^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/i);
  const text = (fenced ? fenced[1] : content).trim();
  try {
    return JSON.parse(text);
  } catch (err) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fall through to the original error */
      }
    }
    throw err;
  }
}

type Validation<T> = { ok: true; data: T } | { ok: false; error: string };

function validate<T>(content: string, schema: z.ZodType<T>): Validation<T> {
  let value: unknown;
  try {
    value = extractJson(content);
  } catch (err) {
    return { ok: false, error: `Output is not valid JSON: ${(err as Error).message}` };
  }
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: `Output does not match the schema:\n${z.prettifyError(result.error)}` };
}

function readChatResponse(json: unknown): { content: string; model?: string } {
  const r = json as { model?: unknown; choices?: { message?: { content?: unknown } }[] };
  const content = r?.choices?.[0]?.message?.content;
  return {
    content: typeof content === "string" ? content : "",
    model: typeof r?.model === "string" && r.model ? r.model : undefined,
  };
}

/**
 * Calls a chat model and returns its JSON output validated against `schema`.
 * On invalid JSON or a schema failure it retries once with the error attached; a second
 * failure throws AiOutputError carrying the raw output.
 */
export async function chatJson<T>(opts: ChatJsonOptions<T>): Promise<ChatJsonResult<T>> {
  const userContent: string | ContentPart[] = opts.files?.length
    ? [
        { type: "text", text: opts.user },
        ...opts.files.map(
          (f): ContentPart => ({
            type: "file",
            file: { filename: f.filename, file_data: `data:${f.mime};base64,${f.base64}` },
          }),
        ),
      ]
    : opts.user;

  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: userContent },
  ];

  const send = async (msgs: ChatMessage[]) =>
    readChatResponse(
      await postJson("/chat/completions", {
        model: opts.model,
        temperature: opts.temperature ?? 0,
        messages: msgs,
        response_format: { type: "json_object" },
        provider: { data_collection: "deny" },
      }, { "X-Prompt-Version": opts.promptVersion }),
    );

  const first = await send(messages);
  const firstCheck = validate(first.content, opts.schema);
  if (firstCheck.ok) {
    return { data: firstCheck.data, model: first.model ?? opts.model, promptVersion: opts.promptVersion };
  }

  const retryMessages: ChatMessage[] = [
    ...messages,
    ...(first.content ? [{ role: "assistant" as const, content: first.content }] : []),
    {
      role: "user",
      content: `${firstCheck.error.slice(0, MAX_ERROR_CHARS)}\n\nReturn only valid JSON matching the schema.`,
    },
  ];
  const second = await send(retryMessages);
  const secondCheck = validate(second.content, opts.schema);
  if (secondCheck.ok) {
    return { data: secondCheck.data, model: second.model ?? opts.model, promptVersion: opts.promptVersion };
  }

  throw new AiOutputError(
    `Model output failed validation twice (${opts.promptVersion}): ${secondCheck.error.slice(0, MAX_ERROR_CHARS)}`,
    second.content,
  );
}

/** Embeds text with an OpenRouter embeddings model. Asserts the vector has `dimensions` entries. */
export async function embed(
  text: string,
  opts: { model: string; dimensions: number },
): Promise<number[]> {
  const json = (await postJson("/embeddings", {
    model: opts.model,
    input: text,
    dimensions: opts.dimensions,
    provider: { data_collection: "deny" },
  })) as { data?: { embedding?: unknown }[] };

  const embedding = json?.data?.[0]?.embedding;
  if (
    !Array.isArray(embedding) ||
    embedding.length !== opts.dimensions ||
    !embedding.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    const got = Array.isArray(embedding) ? `${embedding.length} values` : typeof embedding;
    throw new AiOutputError(
      `Embedding has wrong shape: expected ${opts.dimensions} numbers, got ${got}`,
      JSON.stringify(json).slice(0, MAX_ERROR_CHARS),
    );
  }
  return embedding as number[];
}
