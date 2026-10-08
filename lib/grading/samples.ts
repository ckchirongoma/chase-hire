import { detectInjection } from "@/lib/sanitise";
import { aggregate, closestIndex } from "./aggregate";
import { unverifiedQuotes } from "./quotes";
import type { CriterionGrade, Evidence } from "./schema";

/**
 * Sample collection and summary for one criterion (docs/09 §7). Pure apart from the injected
 * `sample` function, so the rules (re-run on missing evidence, quote verification, median,
 * spread, review reasons) are unit-testable without a model or a database.
 */

export const SAMPLE_COUNT = 3;
export const SAMPLE_TEMPERATURE = 0.3;

export type SampleOutput = CriterionGrade & {
  model: string;
  /** Reference-guided extras (reference_mapping, red_flags_triggered, ...) kept in grades.extra. */
  extra?: Record<string, unknown>;
  /** The sample is unusable whatever its evidence (e.g. its output failed validation twice). */
  invalid?: boolean;
  /** Why the output was unusable (stored for the admin). */
  outputError?: string;
};

export interface SampleRecord {
  idx: number;
  score: number;
  evidence: Evidence[];
  rationale: string;
  feedback: string;
  model: string;
  /** No evidence quotes even after the one re-run: stored, but excluded from the median. */
  invalid: boolean;
  /** True when the first attempt had no evidence and the sample was re-run. */
  rerun: boolean;
  /** Quotes that do not appear in the subject text. */
  unverifiedQuotes: string[];
  /** A quote carries instruction-like text aimed at an AI. */
  injectionInQuotes: boolean;
  /** Extras from the judge output (see SampleOutput.extra). */
  extra?: Record<string, unknown>;
  /** Set when the model's output failed validation twice (the sample is invalid). */
  outputError?: string;
}

export interface CollectOptions {
  count?: number;
  evidenceRequired: boolean;
  /** The text the quotes must come from (already sanitised). */
  subjectText: string;
  /** Runs one model call. `attempt` is 0 for the first call and 1 for the evidence re-run. */
  sample: (idx: number, attempt: number) => Promise<SampleOutput>;
}

export async function collectSamples(opts: CollectOptions): Promise<SampleRecord[]> {
  const count = opts.count ?? SAMPLE_COUNT;
  const one = async (idx: number): Promise<SampleRecord> => {
    let out = await opts.sample(idx, 0);
    let rerun = false;
    if (opts.evidenceRequired && out.evidence.length === 0 && !out.invalid) {
      rerun = true;
      out = await opts.sample(idx, 1);
    }
    const invalid = out.invalid === true || (opts.evidenceRequired && out.evidence.length === 0);
    return {
      idx,
      score: out.score,
      evidence: out.evidence,
      rationale: out.rationale,
      feedback: out.feedback,
      model: out.model,
      invalid,
      rerun,
      unverifiedQuotes: unverifiedQuotes(out.evidence, opts.subjectText),
      injectionInQuotes: out.evidence.some((e) => detectInjection(e.quote)),
      ...(out.extra ? { extra: out.extra } : {}),
      ...(out.outputError ? { outputError: out.outputError } : {}),
    };
  };
  return Promise.all(Array.from({ length: count }, (_, i) => one(i)));
}

export interface CriterionSummary {
  median: number | null;
  spread: number | null;
  needsHumanReview: boolean;
  reviewReason: string | null;
  /** Feedback of the valid sample closest to the median. */
  feedback: string | null;
  /** Index (sample_idx) of that sample, or null. */
  representativeIdx: number | null;
  validCount: number;
}

export function summariseSamples(samples: readonly SampleRecord[], total = SAMPLE_COUNT): CriterionSummary {
  const valid = samples.filter((s) => !s.invalid);
  const reasons: string[] = [];

  if (valid.length < 2) {
    reasons.push(`Only ${valid.length} of ${total} samples gave the required evidence quotes`);
  }
  const agg = aggregate(valid.map((s) => s.score));
  if (agg.spread !== null && agg.needsHumanReview) {
    reasons.push(`Samples disagree by ${agg.spread} points`);
  }
  if (samples.some((s) => s.unverifiedQuotes.length > 0)) {
    reasons.push("A quoted excerpt was not found in the candidate's text");
  }

  let representativeIdx: number | null = null;
  let feedback: string | null = null;
  if (agg.median !== null && valid.length) {
    const i = closestIndex(valid.map((s) => s.score), agg.median);
    representativeIdx = valid[i].idx;
    feedback = valid[i].feedback || null;
  }

  return {
    median: agg.median,
    spread: agg.spread,
    needsHumanReview: reasons.length > 0,
    reviewReason: reasons.length ? reasons.join("; ") : null,
    feedback,
    representativeIdx,
    validCount: valid.length,
  };
}
