import "server-only";
import { aiEnv } from "@/lib/env";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Cost cap per summary: a few short paragraphs. */
export const MAX_SUMMARY_TOKENS = 400;

export class AiNotConfiguredError extends Error {
  constructor() {
    super("AI summary is not configured (OPENROUTER_API_KEY / OPENROUTER_MODEL).");
  }
}

export async function chatCompletion(messages: ChatMessage[]): Promise<{ text: string; model: string }> {
  const env = aiEnv();
  if (!env.apiKey || !env.model) throw new AiNotConfiguredError();
  const body = {
    model: env.model,
    messages,
    max_tokens: MAX_SUMMARY_TOKENS,
    temperature: 0.2,
  };
  const res = await fetch(`${env.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Kopano Renewal Desk",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`OpenRouter returned ${res.status}`);
  const data = (await res.json()) as { model?: string; choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenRouter returned no text");
  return { text, model: data.model ?? env.model };
}
