import { z } from "zod";

/** The AI candidate brief (prompts/candidate-brief.v1.md). Internal and advisory. */
const Point = z.object({ point: z.string().trim().min(1).max(600), evidence: z.string().trim().max(600).default("") });

export const BRIEF_RECOMMENDATIONS = ["advance", "hold", "do_not_advance", "too_early"] as const;

export const CandidateBrief = z.object({
  headline: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(2000),
  strengths: z.array(Point).max(6).default([]),
  concerns: z.array(Point).max(6).default([]),
  recommendations: z
    .array(
      z.object({
        role: z.string().trim().min(1).max(200),
        recommendation: z.enum(BRIEF_RECOMMENDATIONS),
        confidence: z.enum(["low", "medium", "high"]),
        reasoning: z.string().trim().min(1).max(1500),
        check_next: z.string().trim().max(600).default(""),
      }),
    )
    .max(4)
    .default([]),
  live_questions: z.array(z.string().trim().min(1).max(400)).max(5).default([]),
});
export type CandidateBrief = z.output<typeof CandidateBrief>;

export const RECOMMENDATION_LABEL: Record<(typeof BRIEF_RECOMMENDATIONS)[number], string> = {
  advance: "Advance",
  hold: "Hold: check first",
  do_not_advance: "Don't advance",
  too_early: "Too early to say",
};
