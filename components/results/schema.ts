import { z } from "zod";

// Shape of public.my_results() (migration 0008). Candidate-safe fields only.

const num = z.coerce.number();

export const InterviewCriterion = z.object({
  key: z.string(),
  final_score: num.nullable(),
  feedback: z.string().nullable(),
  under_review: z.boolean().nullable().transform((v) => v === true),
});

export const InterviewResult = z.object({
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  end_reason: z.string().nullable(),
  score: num.nullable(),
  criteria: z.array(InterviewCriterion).nullable().transform((v) => v ?? []),
});

export const QuizResultRow = z.object({
  started_at: z.string().nullable(),
  submitted_at: z.string().nullable(),
  raw_score: num.nullable(),
  pct: num.nullable(),
  topic_scores: z.record(z.string(), z.object({ correct: num, total: num })).nullable(),
});

export const WorkResultRow = z.object({
  stage_key: z.string(),
  app_stage: z.string(),
  title: z.string(),
  open_until: z.string().nullable(),
  started_at: z.string().nullable(),
  deadline_at: z.string().nullable(),
  submitted_at: z.string().nullable(),
  score: num.nullable(),
  grading_status: z.string().nullable(),
  criteria: z.array(InterviewCriterion).nullable().transform((v) => v ?? []),
});

export const DecisionRow = z.object({
  stage: z.string(),
  decision: z.string(),
  reason: z.string(),
  decided_at: z.string(),
});

export const ApplicationResult = z.object({
  application_id: z.string(),
  role_slug: z.string(),
  role_title: z.string(),
  stage: z.string(),
  status: z.string(),
  below_hurdle: z.boolean(),
  created_at: z.string(),
  interview: InterviewResult.nullable(),
  quiz: QuizResultRow.nullable(),
  work: z.array(WorkResultRow).nullable().optional().transform((v) => v ?? []),
  decisions: z.array(DecisionRow).nullable().transform((v) => v ?? []),
});

export const MyResults = z.array(ApplicationResult);

export type ApplicationResult = z.output<typeof ApplicationResult>;
export type InterviewResult = z.output<typeof InterviewResult>;
export type QuizResultRow = z.output<typeof QuizResultRow>;
export type WorkResultRow = z.output<typeof WorkResultRow>;
