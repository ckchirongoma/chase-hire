import { z } from "zod";
import type { RubricCriterion, RubricSubcriterion } from "@/lib/grading/schema";

/**
 * Which rubric criteria the gold set calibrates (docs/09 §8). Calibration measures the LLM judge,
 * so it covers every leaf the judge scores: llm criteria and sub-criteria, plus computed criteria
 * whose score comes from a judge's answer-key mapping (gap recall, A-key coverage, F-key fault
 * points). Leaves computed from platform data alone (elicitation yield from the persona's revealed
 * facts, harness checks) are deterministic and not calibrated against human raters.
 */

export const PLATFORM_COMPUTATIONS = ["elicitation_yield", "harness_import", "harness_stories", "harness_deploy"] as const;

export interface CalibrationLeaf {
  /** grade_summaries.criterion_key: "<key>" or "<parent>.<sub>". */
  key: string;
  title: string;
  parentTitle: string | null;
  criterion: RubricCriterion | RubricSubcriterion;
}

export function isCalibrated(c: RubricCriterion | RubricSubcriterion): boolean {
  if (c.computation && (PLATFORM_COMPUTATIONS as readonly string[]).includes(c.computation)) return false;
  return c.method === "llm" || Boolean(c.computation && c.prompt);
}

/** The calibrated leaves of a rubric, in rubric order. */
export function calibrationLeaves(criteria: readonly RubricCriterion[]): CalibrationLeaf[] {
  const out: CalibrationLeaf[] = [];
  for (const c of criteria) {
    if (c.subcriteria?.length) {
      for (const s of c.subcriteria) if (isCalibrated(s)) out.push({ key: `${c.key}.${s.key}`, title: s.title, parentTitle: c.title, criterion: s });
    } else if (isCalibrated(c)) out.push({ key: c.key, title: c.title, parentTitle: null, criterion: c });
  }
  return out;
}

// ───────────────────────── Human scores ─────────────────────────

const Score = z.number().int().min(1).max(5).nullable();
/** gold_samples.human_scores: {criterion_key: [rater 1, rater 2]} on 1–5 (null = not scored yet). */
export const HumanScores = z.record(z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)?$/), z.tuple([Score, Score]));
export type HumanScores = z.output<typeof HumanScores>;

/** Reads stored human scores leniently (unknown shapes become "not scored"). */
export function readHumanScores(raw: unknown): HumanScores {
  const out: HumanScores = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue;
    const s = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= 5 ? x : null);
    out[k] = [s(v[0]), s(v[1])];
  }
  return out;
}

/**
 * Human scores from form fields named "h1:<key>" and "h2:<key>" for the given leaves. Empty means
 * not scored; anything else must be an integer 1–5.
 */
export function humanScoresFromForm(fields: Record<string, unknown>, keys: readonly string[]): { scores: HumanScores; invalid: string[] } {
  const scores: HumanScores = {};
  const invalid: string[] = [];
  const read = (name: string): number | null | "bad" => {
    const v = fields[name];
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : "bad";
  };
  for (const k of keys) {
    const a = read(`h1:${k}`);
    const b = read(`h2:${k}`);
    if (a === "bad" || b === "bad") {
      invalid.push(k);
      continue;
    }
    if (a !== null || b !== null) scores[k] = [a, b];
  }
  return { scores, invalid };
}

/** How many leaves both raters have scored. */
export function scoredByBoth(scores: HumanScores, keys: readonly string[]): number {
  return keys.filter((k) => scores[k]?.[0] != null && scores[k]?.[1] != null).length;
}
