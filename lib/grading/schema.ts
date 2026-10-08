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

/** How a criterion's score is produced. */
export const RUBRIC_METHODS = ["llm", "computed", "mixed"] as const;
/** The judge prompts a criterion can name (prompts/<key>.v1.md). */
export const GRADER_PROMPTS = ["grader-criterion", "gap-recall-grader", "elicitation-grader", "answer-key-grader"] as const;
export type GraderPrompt = (typeof GRADER_PROMPTS)[number];

const criterionFields = {
  key: z.string().min(1),
  title: z.string().min(1),
  weight: z.number().min(0).default(1),
  description: z.string().default(""),
  anchors: z.record(z.string(), z.string()).default({}),
  evidence_required: z.boolean().default(false),
  method: z.enum(RUBRIC_METHODS).default("llm"),
  /** Judge prompt for llm (and LLM-mapped computed) criteria. */
  prompt: z.enum(GRADER_PROMPTS).optional(),
  /** Platform computation for computed criteria, e.g. "gap_recall", "elicitation_yield", "answer_key". */
  computation: z.string().optional(),
  /** Which parts of the submission the judge sees, e.g. ["memo"], ["loom"], ["readme", "harness"]. */
  sources: z.array(z.string()).optional(),
  /** Keys of rubrics.reference (or bundle-derived blocks) given to the judge as REFERENCE. */
  reference_keys: z.array(z.string()).optional(),
  /** Generic-baseline use (docs/09 §3 P3): required → flagged for review when the rubric has none. */
  baseline: z.enum(["required", "optional"]).optional(),
  /** When set, this criterion always needs a person (the text is the review reason). */
  human_check: z.string().optional(),
};

const RubricSubcriterion = z.object(criterionFields);
export type RubricSubcriterion = z.output<typeof RubricSubcriterion>;

/** A rubric criterion as stored in rubrics.criteria (subcriteria are graded as "<key>.<sub key>"). */
export const RubricCriterion = z.object({ ...criterionFields, subcriteria: z.array(RubricSubcriterion).optional() });
export type RubricCriterion = z.output<typeof RubricCriterion>;

const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);
const upper = (v: unknown) => (typeof v === "string" ? v.trim().toUpperCase() : v);

const STATUS_SYNONYMS: Record<string, "found" | "partial" | "missing"> = {
  yes: "found",
  present: "found",
  covered: "found",
  fixed: "found",
  partially: "partial",
  "partly found": "partial",
  "partially found": "partial",
  weak: "partial",
  no: "missing",
  absent: "missing",
  "not found": "missing",
  none: "missing",
};
const mappingStatus = (v: unknown) => {
  const s = lower(v);
  return typeof s === "string" ? (STATUS_SYNONYMS[s] ?? s) : s;
};

/** One answer-key item mapped by the judge (docs/10 grader-criterion reference_mapping). */
export const MappingItem = z.object({
  id: z.preprocess(upper, z.string().min(1).max(20)),
  status: z.preprocess(mappingStatus, z.enum(["found", "partial", "missing"])),
  quote: z
    .string()
    .max(1500)
    .nullish()
    .transform((v) => v ?? ""),
});
export type MappingItem = z.output<typeof MappingItem>;

/** A triggered red flag (docs/08), as an id or {id, quote}. */
const RedFlag = z.preprocess(
  (v) => (typeof v === "string" ? { id: v } : v),
  z.object({
    id: z.preprocess(lower, z.string().min(1).max(60)),
    quote: z
      .string()
      .max(1500)
      .nullish()
      .transform((q) => q ?? ""),
  }),
);

/** A judge sample with reference-guided extras (docs/10): stored in grades.extra. */
export const ReferenceGrade = CriterionGrade.extend({
  reference_mapping: z
    .array(MappingItem)
    .max(40)
    .nullish()
    .transform((v) => v ?? []),
  red_flags_triggered: z
    .array(RedFlag)
    .max(10)
    .nullish()
    .transform((v) => v ?? []),
  extra_valid_gaps: z
    .array(
      z.preprocess(
        (v) => (typeof v === "string" ? { gap: v } : v),
        z.object({
          gap: z.string().trim().min(1).max(500),
          quote: z
            .string()
            .max(1500)
            .nullish()
            .transform((q) => q ?? ""),
        }),
      ),
    )
    .max(15)
    .nullish()
    .transform((v) => v ?? []),
});
export type ReferenceGrade = z.output<typeof ReferenceGrade>;

/**
 * Why a judge's reference_mapping is unusable for a key (empty = usable): docs/10 requires every
 * id of the key exactly once. A missing id must not silently count as "missing".
 */
export function mappingProblems(mapping: readonly Pick<MappingItem, "id" | "status">[], ids: readonly string[]): string[] {
  const want = new Set(ids);
  const seen = new Map<string, string>();
  const dupes = new Set<string>();
  const unknown = new Set<string>();
  for (const m of mapping) {
    if (!want.has(m.id)) unknown.add(m.id);
    else if (seen.has(m.id) && seen.get(m.id) !== m.status) dupes.add(m.id);
    else seen.set(m.id, m.status);
  }
  const missing = ids.filter((id) => !seen.has(id));
  const out: string[] = [];
  if (missing.length) out.push(`reference_mapping must list every id of the key exactly once; missing: ${missing.join(", ")}`);
  if (unknown.size) out.push(`reference_mapping has ids that are not in the key: ${[...unknown].join(", ")}`);
  if (dupes.size) out.push(`reference_mapping lists these ids more than once with different statuses: ${[...dupes].join(", ")}`);
  return out;
}

/**
 * ReferenceGrade that also requires reference_mapping to cover exactly `ids` (one entry each).
 * A failure goes back to the model through chatJson's one retry; a second failure is an invalid
 * sample (gradeCriterion with invalidOnOutputError), never a silent score of 1.
 */
export function referenceGradeFor(ids: readonly string[]) {
  return ReferenceGrade.superRefine((v, ctx) => {
    for (const message of mappingProblems(v.reference_mapping, ids)) ctx.addIssue({ code: "custom", message, path: ["reference_mapping"] });
  });
}

export const RubricRow = z.object({
  id: z.string(),
  key: z.string(),
  version: z.number(),
  title: z.string(),
  criteria: z.array(RubricCriterion),
  generic_baseline: z.string().nullish(),
  /** Answer keys and gold excerpts for reference-guided grading (migration 0011+). */
  reference: z.record(z.string(), z.unknown()).nullish(),
});
export type RubricRow = z.output<typeof RubricRow>;
