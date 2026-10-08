// Candidate-facing labels for the results page.

export const CRITERION_LABEL: Record<string, string> = {
  specificity: "Specificity",
  ownership: "Ownership",
  depth_under_probe: "Depth under follow-up questions",
  cv_consistency: "Consistency with your CV",
  situational_judgement: "Situational judgement",
  communication: "Communication",
};

export const DECISION_LABEL: Record<string, string> = {
  advance: "Advanced",
  reject: "Not progressing",
  hold: "Held for review",
  lapse: "Closed (no activity)",
};

export const REVIEW_STAGE_LABEL: Record<string, string> = {
  reasoning: "Reasoning Assessment",
  cv: "CV reading",
  interview: "AI CV interview",
  quiz: "Role quiz",
  work_1: "Work assessment 1",
  work_2: "Work assessment 2",
  live: "Live session",
  decision: "Application decision",
};

export function criterionLabel(key: string): string {
  return CRITERION_LABEL[key] ?? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** 1-5 rubric score for display: "3/5", or "3.5/5" for a fractional human score. */
export function fmtRubric(score: number): string {
  return `${Number.isInteger(score) ? score : score.toFixed(1)}/5`;
}

/** Whole-number percentage for display. */
export function fmtPct(pct: number): string {
  return `${Math.round(pct)}%`;
}
