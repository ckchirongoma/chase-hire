import { z } from "zod";
import { FOLLOWUP_TARGETS, templateFollowup } from "./script";
import type { FollowupTarget } from "./types";

/**
 * Follow-up questions are written by an LLM from the candidate's own answer (so the
 * conversation actually unpacks the CV), then checked here. Anything that fails a check is
 * replaced by the template for the same target, so a bad generation can never reach the
 * candidate. The interviewer must not evaluate, praise, mention scoring or repeat itself.
 */

export const FollowupOutput = z.object({
  question: z.string().trim().min(1).max(600),
  target: z.enum(FOLLOWUP_TARGETS as [FollowupTarget, ...FollowupTarget[]]).optional(),
});
export type FollowupOutput = z.infer<typeof FollowupOutput>;

export const FOLLOWUP_MIN_CHARS = 15;
export const FOLLOWUP_MAX_CHARS = 350;

const EVALUATIVE =
  /\b(great|excellent|good answer|nice|well done|impressive|perfect|wonderful|fantastic|brilliant|amazing|interesting answer|correct|incorrect|wrong answer|score[ds]?|scoring|grade[ds]?|grading|rating|marks?|pass(ed)?|fail(ed)?|thank you for (that|your) (great|excellent|detailed))\b/i;
const META = /\b(system prompt|instructions?|as an ai|language model|interviewer bot|chatgpt|openai|anthropic)\b/i;

function normalise(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Word-set overlap (Jaccard) between two questions, 0..1. */
export function similarity(a: string, b: string): number {
  const A = new Set(normalise(a).split(" ").filter((w) => w.length > 2));
  const B = new Set(normalise(b).split(" ").filter((w) => w.length > 2));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export type FollowupCheck = { ok: true; question: string } | { ok: false; reason: string };

export function checkFollowup(raw: string, previous: readonly string[]): FollowupCheck {
  const q = raw.replace(/\s+/g, " ").trim();
  if (q.length < FOLLOWUP_MIN_CHARS) return { ok: false, reason: "too_short" };
  if (q.length > FOLLOWUP_MAX_CHARS) return { ok: false, reason: "too_long" };
  if (!q.includes("?")) return { ok: false, reason: "not_a_question" };
  if ((q.match(/[.?!](\s|$)/g) ?? []).length > 3) return { ok: false, reason: "too_many_sentences" };
  if (/https?:\/\/|```|<\/?[a-z]/i.test(q)) return { ok: false, reason: "markup" };
  if (EVALUATIVE.test(q)) return { ok: false, reason: "evaluative" };
  if (META.test(q)) return { ok: false, reason: "meta" };
  if (previous.some((p) => normalise(p) === normalise(q) || similarity(p, q) >= 0.8)) return { ok: false, reason: "repeat" };
  return { ok: true, question: q };
}

/** The question to ask: the checked LLM output, or the template for the target. */
export function resolveFollowup(
  generated: FollowupOutput | null,
  target: FollowupTarget,
  previous: readonly string[],
): { text: string; target: FollowupTarget; via: "llm" | "template"; rejected: string | null } {
  if (generated) {
    const check = checkFollowup(generated.question, previous);
    if (check.ok) return { text: check.question, target: generated.target ?? target, via: "llm", rejected: null };
    return { text: templateFollowup(target), target, via: "template", rejected: check.reason };
  }
  return { text: templateFollowup(target), target, via: "template", rejected: null };
}
