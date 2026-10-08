import { GRADER_PROMPTS, RUBRIC_METHODS, RubricCriterion, type RubricSubcriterion } from "../schema";
import { BA_PART1, BA_PART1_V2 } from "./ba-part1";
import { BA_PART2 } from "./ba-part2";
import { SWE_TEST1 } from "./swe-test1";
import { SWE_TEST2 } from "./swe-test2";
import type { RubricDefinition } from "./types";

/**
 * Work-assessment rubrics, version 1: the source of truth for migration 0012's seed
 * (tests/unit/rubrics checks the migration still matches). A change here means a NEW rubric
 * version in a new migration, then a gold-set re-run before going live (CLAUDE.md).
 */

export const WORK_RUBRICS: readonly RubricDefinition[] = [BA_PART1, BA_PART2, SWE_TEST1, SWE_TEST2];

/** The rubric versions graders use now (later versions arrive in later migrations: BA Part 1 v2 in 0022). */
export const ACTIVE_WORK_RUBRICS: readonly RubricDefinition[] = [BA_PART1_V2, BA_PART2, SWE_TEST1, SWE_TEST2];
export type { RubricDefinition };

/** Reference blocks built at grading time from the stage's dataset bundle, not stored in the rubric. */
export const DYNAMIC_REFERENCE_KEYS = ["bundle_evidence", "bundle_figures"] as const;

const COMPUTATIONS = ["gap_recall", "elicitation_yield", "answer_key", "fault_points", "harness_import", "harness_stories", "harness_deploy"] as const;

/** Shape problems in a rubric definition (empty = valid). */
export function rubricProblems(r: RubricDefinition): string[] {
  const out: string[] = [];
  const sum = r.criteria.reduce((s, c) => s + c.weight, 0);
  if (Math.abs(sum - 100) > 1e-9) out.push(`${r.key}: weights sum to ${sum}, not 100`);
  const keys = new Set<string>();
  const check = (c: RubricSubcriterion | RubricCriterion, path: string, isParent: boolean) => {
    if (!RubricCriterion.safeParse(c).success) out.push(`${path}: does not parse as a rubric criterion`);
    if (keys.has(path)) out.push(`${path}: duplicate key`);
    keys.add(path);
    if (!/^[a-z0-9_]+$/.test(c.key)) out.push(`${path}: key must be lower snake case`);
    for (const level of ["1", "3", "5"]) if (!c.anchors[level]?.trim()) out.push(`${path}: missing anchor ${level}`);
    if (typeof c.evidence_required !== "boolean") out.push(`${path}: evidence_required not set`);
    if (!RUBRIC_METHODS.includes(c.method)) out.push(`${path}: bad method ${c.method}`);
    if (!(c.weight > 0)) out.push(`${path}: weight must be > 0`);
    if (c.prompt && !GRADER_PROMPTS.includes(c.prompt)) out.push(`${path}: unknown prompt ${c.prompt}`);
    if (c.computation && !(COMPUTATIONS as readonly string[]).includes(c.computation)) out.push(`${path}: unknown computation ${c.computation}`);
    if (!isParent) {
      if (c.method === "llm" && !c.prompt) out.push(`${path}: llm criterion needs a prompt`);
      if (c.method === "computed" && !c.computation) out.push(`${path}: computed criterion needs a computation`);
      if (c.method === "mixed") out.push(`${path}: mixed criteria need subcriteria`);
      if (c.prompt && !c.sources?.length) out.push(`${path}: judged criterion needs sources`);
    }
    for (const k of c.reference_keys ?? []) {
      if (!(k in r.reference) && !(DYNAMIC_REFERENCE_KEYS as readonly string[]).includes(k)) out.push(`${path}: unknown reference key ${k}`);
    }
  };
  for (const c of r.criteria) {
    const subs = (c as RubricCriterion).subcriteria ?? [];
    check(c, c.key, subs.length > 0);
    for (const s of subs) {
      if ((s as RubricCriterion).subcriteria) out.push(`${c.key}.${s.key}: subcriteria cannot nest`);
      check(s, `${c.key}.${s.key}`, false);
    }
  }
  return out;
}
