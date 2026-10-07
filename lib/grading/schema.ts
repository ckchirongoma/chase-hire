import { z } from "zod";

/** Subject types a grade can belong to (grades.subject_type). */
export const SUBJECT_TYPES = ["interview", "submission", "gold"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

const numberish = (v: unknown) => (typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v);
const stringish = (v: unknown) => (typeof v === "number" ? String(v) : v);

export const Evidence = z.object({
  quote: z.string().trim().min(1).max(1500),
  location: z.preprocess(stringish, z.string().trim().max(120)).nullish().transform((v) => v ?? ""),
});
export type Evidence = z.output<typeof Evidence>;

/**
 * One judge sample for ONE criterion (docs/09 §7.2): evidence first, then rationale, then score,
 * plus a short candidate-safe feedback sentence.
 */
export const CriterionGrade = z.object({
  evidence: z
    .array(Evidence)
    .max(6)
    .nullish()
    .transform((v) => v ?? []),
  rationale: z.string().trim().min(1).max(4000),
  score: z.preprocess(numberish, z.number().int().min(1).max(5)),
  feedback: z
    .string()
    .trim()
    .max(400)
    .nullish()
    .transform((v) => v ?? ""),
});
export type CriterionGrade = z.output<typeof CriterionGrade>;

/** A rubric criterion as stored in rubrics.criteria. */
export const RubricCriterion = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  weight: z.number().min(0).default(1),
  description: z.string().default(""),
  anchors: z.record(z.string(), z.string()).default({}),
  evidence_required: z.boolean().default(false),
  method: z.enum(["llm", "computed"]).default("llm"),
});
export type RubricCriterion = z.output<typeof RubricCriterion>;

export const RubricRow = z.object({
  id: z.string(),
  key: z.string(),
  version: z.number(),
  title: z.string(),
  criteria: z.array(RubricCriterion),
  generic_baseline: z.string().nullish(),
});
export type RubricRow = z.output<typeof RubricRow>;
