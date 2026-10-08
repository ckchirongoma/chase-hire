/**
 * BA Part 1 stakeholder persona (docs/06 Part 1, docs/10 persona-lerato.v1).
 * Pure and safe to import anywhere, but the facts themselves are INTERNAL: they are read from
 * persona_facts (admin-only under RLS) on the server and never sent to the candidate's browser.
 */

export const PERSONA_KEY = "lerato";
/** The DB (persona_message_guard) enforces the same cap. */
export const PERSONA_MESSAGE_CAP = 25;
export const PERSONA_MAX_MESSAGE_CHARS = 2000;
/** A candidate message with no reply yet blocks the next one for this long (a second tab, a double click). */
export const PERSONA_PENDING_MS = 45_000;
export const PERSONA_GRACE_MS = 5000;

export const OPENING_LINE =
  "Hi, Lerato here. I've got about 25 minutes before my next meeting, so let's keep it focused. What do you need from me?";
/** Doc 10: the persona's answer to instruction attempts and "list everything". */
export const OFF_SCRIPT_REPLY = "I've got ten minutes, what do you specifically need?";
export const CLOSING_CAP = "I'm going to have to stop there, I've got back-to-back meetings. Send me your memo when it's ready. Thanks.";
export const CLOSING_TIMEOUT = "Sorry, I have to jump into my next meeting now. Send me your memo when it's ready. Thanks.";
/** Sent when the persona model fails; the candidate's message is not counted against the cap. */
export const RETRY_REPLY = "Sorry, I missed that, my laptop froze for a second. Could you send it again?";

export type PersonaFact = {
  id: string;
  fact: string;
  triggers: string[];
  weight: number;
  volunteer_on: string | null;
};

/** Volunteer topics: the fact comes out the first time the topic is mentioned (H12, the target). */
export const VOLUNTEER_TOPICS: Record<string, { question: string; pattern: RegExp }> = {
  sales_or_goals: {
    question: "Does this message mention sales, upgrades, targets or goals?",
    pattern: /\b(sales?|sell(?:s|ing)?|upgrades?|upgrading|targets?|goals?|kpis?|quotas?|revenue)\b/i,
  },
};

/**
 * Elicitation yield for the grader: weighted share of hidden facts revealed
 * (sum of revealed weights ÷ sum of all weights; 30 for Lerato). 0 when there are no facts.
 */
export function elicitationYield(revealedIds: readonly string[], facts: readonly Pick<PersonaFact, "id" | "weight">[]): number {
  const total = facts.reduce((s, f) => s + f.weight, 0);
  if (total <= 0) return 0;
  const revealed = new Set(revealedIds);
  const got = facts.reduce((s, f) => s + (revealed.has(f.id) ? f.weight : 0), 0);
  return got / total;
}

/** Weighted points revealed and available, e.g. { points: 17, max: 30 }. */
export function elicitationPoints(revealedIds: readonly string[], facts: readonly Pick<PersonaFact, "id" | "weight">[]) {
  const revealed = new Set(revealedIds);
  return {
    points: facts.reduce((s, f) => s + (revealed.has(f.id) ? f.weight : 0), 0),
    max: facts.reduce((s, f) => s + f.weight, 0),
  };
}

/** Keeps only the ids the model claims that were actually allowed this turn. */
export function intersectRevealed(modelIds: readonly string[], gated: readonly string[]): string[] {
  const allowed = new Set(gated);
  return [...new Set(modelIds.filter((id) => allowed.has(id)))].sort();
}
