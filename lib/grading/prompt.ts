import type { RubricCriterion } from "./schema";

/**
 * Prompt fragments shared by every grader. The system prompt itself lives in prompts/*.md;
 * these build the per-call user content around the (already sanitised and wrapped) subject.
 */

/** The anchored criterion block (docs/09 §7.1: one criterion per call, anchors at 1/3/5). */
export function criterionBlock(c: RubricCriterion): string {
  const anchors = Object.entries(c.anchors)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([level, text]) => `  ${level}: ${text}`)
    .join("\n");
  return [
    `CRITERION: ${c.title} (key: ${c.key})`,
    c.description ? `Description: ${c.description}` : null,
    anchors ? `Anchors (2 and 4 are in between):\n${anchors}` : null,
    c.evidence_required ? "Evidence is REQUIRED for this criterion: quote the candidate verbatim." : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Appended on the one re-run when a sample came back without evidence. */
export const EVIDENCE_NUDGE =
  "Your previous answer for this criterion had no evidence. Evidence is required: give 1 to 3 verbatim quotes from the candidate's own text, each with its location, then the rationale and score.";
