/**
 * Composite scores (docs/09 §2). Every component is on 0–100. The composite SORTS the
 * admin's queue; it never decides an outcome.
 *
 * - Pre-live composite: weighted mean of the stage scores the candidate has so far, with the
 *   weights renormalised over what exists, plus `coverage` (the share of the full weight
 *   present) so a partial composite is never mistaken for a complete one.
 * - Final composite: 50% pre-live + 50% live, only once both are complete.
 */

export type PreLiveKey = "reasoning" | "interview" | "quiz" | "work_1" | "work_2";
export type LiveKey = "panel_interview" | "live_defence" | "live_elicitation" | "exec_scenario";

export const PRE_LIVE_KEYS: readonly PreLiveKey[] = ["reasoning", "interview", "quiz", "work_1", "work_2"];

export const PRE_LIVE_WEIGHTS: Readonly<Record<string, Readonly<Record<PreLiveKey, number>>>> = {
  "business-analyst": { reasoning: 10, interview: 15, quiz: 15, work_1: 30, work_2: 30 },
  "software-engineer": { reasoning: 10, interview: 15, quiz: 15, work_1: 35, work_2: 25 },
};

export const LIVE_WEIGHTS: Readonly<Record<string, Readonly<Partial<Record<LiveKey, number>>>>> = {
  "business-analyst": { panel_interview: 40, live_defence: 30, live_elicitation: 30 },
  "software-engineer": { panel_interview: 40, live_defence: 40, exec_scenario: 20 },
};

/** Roles added later without their own weights use the BA split. */
export function preLiveWeights(roleSlug: string): Readonly<Record<PreLiveKey, number>> {
  return PRE_LIVE_WEIGHTS[roleSlug] ?? PRE_LIVE_WEIGHTS["business-analyst"];
}
export function liveWeights(roleSlug: string): Readonly<Partial<Record<LiveKey, number>>> {
  return LIVE_WEIGHTS[roleSlug] ?? LIVE_WEIGHTS["business-analyst"];
}

export type Components<K extends string> = Partial<Record<K, number | null>>;

export interface Weighted {
  /** 0–100 weighted mean over the components present; null when none are. */
  score: number | null;
  /** Share of the total weight present, 0–1. */
  coverage: number;
  missing: string[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const valid = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;

export function weightedComposite<K extends string>(weights: Readonly<Partial<Record<K, number>>>, parts: Components<K>): Weighted {
  let sum = 0;
  let present = 0;
  let total = 0;
  const missing: string[] = [];
  for (const [key, w] of Object.entries(weights) as [K, number][]) {
    if (!w) continue;
    total += w;
    const v = parts[key];
    if (valid(v)) {
      sum += v * w;
      present += w;
    } else missing.push(key);
  }
  return {
    score: present ? round1(sum / present) : null,
    coverage: total ? round1((present / total) * 100) / 100 : 0,
    missing,
  };
}

export function preLiveComposite(roleSlug: string, parts: Components<PreLiveKey>): Weighted {
  return weightedComposite(preLiveWeights(roleSlug), parts);
}

export function liveComposite(roleSlug: string, parts: Components<LiveKey>): Weighted {
  return weightedComposite(liveWeights(roleSlug), parts);
}

/** Final = 50% pre-live + 50% live; null until both are complete. */
export function finalComposite(preLive: Weighted, live: Weighted): number | null {
  if (preLive.score === null || live.score === null || preLive.coverage < 1 || live.coverage < 1) return null;
  return round1(0.5 * preLive.score + 0.5 * live.score);
}

/** Rubric 1–5 → 0–100 (1 = 0, 3 = 50, 5 = 100). */
export function rubricTo100(score: number): number {
  return round1(((score - 1) / 4) * 100);
}

/** Criterion keys that score executive communication in each stage (docs/09 §4). */
export const EXEC_COMMS_KEYS: readonly string[] = ["communication", "exec_comms", "exec_comms_loom", "s9_communication"];

/** Cross-stage executive communication: the mean of every instance, on 0–100. */
export function execCommsScore(instances: readonly (number | null | undefined)[]): { score: number | null; n: number } {
  const vals = instances.filter((v): v is number => typeof v === "number" && v >= 1 && v <= 5).map(rubricTo100);
  return { score: vals.length ? round1(vals.reduce((a, b) => a + b, 0) / vals.length) : null, n: vals.length };
}

/** Mean of submitted raters' totals per live scorecard kind (each 0–100). */
export function liveParts(cards: readonly { kind: string; total: number | null; submitted: boolean }[]): Components<LiveKey> {
  const by = new Map<string, number[]>();
  for (const c of cards) {
    if (!c.submitted || !valid(c.total)) continue;
    by.set(c.kind, [...(by.get(c.kind) ?? []), c.total]);
  }
  const out: Components<LiveKey> = {};
  for (const [k, v] of by) out[k as LiveKey] = round1(v.reduce((a, b) => a + b, 0) / v.length);
  return out;
}
