import { z } from "zod";

/**
 * JEV: TypeSafe's "System One" model. A fast, cheap, typed decision model: send a state
 * and predefined questions, get back typed answers with probabilities. It writes no text
 * and gives no rationale, so it is used only for flow-control decisions (see
 * docs/15-jev-system-one.md), never for grades or hiring decisions.
 *
 * Every call is best-effort: on a missing key, timeout or error it returns null and the
 * caller falls back to a deterministic rule.
 */

export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Readonly<Record<string, string>> };
export type ScoreQuestion = { type: "score"; instructions: string; criteria: readonly string[] };
export type NoulQuestion = { type: "noul"; instructions: string };
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
});
const ScoreAnswer = z.object({
  type: z.literal("score"),
  score: z.number(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()).optional(),
  legend: z.record(z.string(), z.string()).optional(),
});
const NoulAnswer = z.object({ type: z.literal("noul"), noul: z.number() });
const Answer = z.discriminatedUnion("type", [ChoiceAnswer, ScoreAnswer, NoulAnswer]);
const Response = z.object({
  model: z.string(),
  answers: z.record(z.string(), Answer),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).partial().optional(),
});

export type ChoiceAnswer = z.infer<typeof ChoiceAnswer>;
export type ScoreAnswer = z.infer<typeof ScoreAnswer>;
export type NoulAnswer = z.infer<typeof NoulAnswer>;
type AnswerFor<Q> = Q extends ChoiceQuestion ? ChoiceAnswer : Q extends ScoreQuestion ? ScoreAnswer : NoulAnswer;
export type Answers<Qs extends Record<string, Question>> = { [K in keyof Qs]: AnswerFor<Qs[K]> };

export type JevResult<Qs extends Record<string, Question>> = { model: string; answers: Answers<Qs>; ms: number };

const DEFAULT_BASE = "https://api.typesafe.ai/v1";
// Pinned so behaviour doesn't shift under us; bump deliberately (and re-run tests).
const DEFAULT_MODEL = "jev-1.13.0";
const TIMEOUT_MS = 5000;

export function jevConfigured(): boolean {
  return !!process.env.TYPESAFE_API_KEY;
}

export async function systemOne<Qs extends Record<string, Question>>(
  state: string | Record<string, unknown> | unknown[],
  questions: Qs,
): Promise<JevResult<Qs> | null> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return null;
  const base = process.env.TYPESAFE_BASE_URL || DEFAULT_BASE;
  const model = process.env.JEV_MODEL || DEFAULT_MODEL;
  const body = JSON.stringify({ model, state, questions });

  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(`${base}/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      if (!res.ok) {
        console.warn("JEV request failed", res.status);
        return null;
      }
      const parsed = Response.safeParse(await res.json());
      if (!parsed.success) {
        console.warn("JEV response invalid", parsed.error.message);
        return null;
      }
      for (const [id, q] of Object.entries(questions)) {
        if (parsed.data.answers[id]?.type !== q.type) return null;
      }
      return { model: parsed.data.model, answers: parsed.data.answers as Answers<Qs>, ms: Date.now() - started };
    } catch (err) {
      if (attempt === 0) continue;
      console.warn("JEV request error", err instanceof Error ? err.message : err);
      return null;
    }
  }
  return null;
}

/** Score answers are 0-based level indices; normalise to 0..1. */
export function scoreFraction(answer: ScoreAnswer, levels: number): number {
  return levels > 1 ? answer.score / (levels - 1) : 0;
}
