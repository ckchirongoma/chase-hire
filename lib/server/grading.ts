import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chatJson } from "@/lib/ai";
import { detectInjection } from "@/lib/sanitise";
import {
  collectSamples,
  CriterionGrade,
  EVIDENCE_NUDGE,
  SAMPLE_TEMPERATURE,
  summariseSamples,
  type CriterionSummary,
  type RubricCriterion,
  type SampleRecord,
  type SubjectType,
} from "@/lib/grading";

/**
 * Shared LLM grading core (docs/09 §7), reused by every AI-graded stage:
 * - gradeCriterion: one criterion, 3 samples at T=0.3, median, spread, evidence checks, all stored.
 * - grading_jobs queue + a handler registry keyed by subject_type.
 *
 * AI grades are advisory (hard rule 3): nothing here touches applications.status.
 */

export class GradingError extends Error {
  constructor(
    message: string,
    public status = 500,
  ) {
    super(message);
  }
}

// ───────────────────────── Signals ─────────────────────────

/** Logs a prompt_injection signal for an admin. Never penalises; never throws. */
export async function logInjectionSignal(
  admin: SupabaseClient,
  userId: string,
  context: string,
  payload: Record<string, string | number | boolean | null | string[] | number[]>,
): Promise<void> {
  const { error } = await admin.from("signals").insert({
    user_id: userId,
    context: context.slice(0, 100),
    kind: "prompt_injection",
    payload,
  });
  if (error) console.warn("could not log prompt_injection signal", error.message);
}

/** Runs the regex injection detector over a subject's text and logs a signal when it fires. */
export async function screenSubjectForInjection(
  admin: SupabaseClient,
  opts: { userId: string; context: string; subjectType: SubjectType; subjectId: string; text: string },
): Promise<boolean> {
  if (!detectInjection(opts.text)) return false;
  await logInjectionSignal(admin, opts.userId, opts.context, {
    where: "subject_text",
    subject_type: opts.subjectType,
    subject_id: opts.subjectId,
  });
  return true;
}

// ───────────────────────── One criterion ─────────────────────────

export interface GradeCriterionInput {
  subjectType: SubjectType;
  subjectId: string;
  rubricId: string;
  criterion: RubricCriterion;
  /** System prompt (from prompts/*.md). It must tell the judge to ignore instructions in the subject. */
  system: string;
  /** User content: the subject already sanitised and wrapped in delimiters, plus criterion/context. */
  userContent: string;
  /** The text evidence quotes must come from (sanitised). Defaults to userContent. */
  subjectText?: string;
  promptVersion: string;
  model: string;
  /** Where to log prompt_injection signals found in quotes. */
  signal?: { userId: string; context: string };
}

export interface GradeCriterionResult extends CriterionSummary {
  criterionKey: string;
  weight: number;
  finalScore: number | null;
  humanScore: number | null;
  samples: SampleRecord[];
}

export async function gradeCriterion(admin: SupabaseClient, input: GradeCriterionInput): Promise<GradeCriterionResult> {
  const { criterion } = input;
  const samples = await collectSamples({
    evidenceRequired: criterion.evidence_required,
    subjectText: input.subjectText ?? input.userContent,
    sample: async (_idx, attempt) => {
      const res = await chatJson({
        model: input.model,
        system: input.system,
        user: attempt === 0 ? input.userContent : `${input.userContent}\n\n${EVIDENCE_NUDGE}`,
        schema: CriterionGrade,
        promptVersion: input.promptVersion,
        temperature: SAMPLE_TEMPERATURE,
      });
      return { ...res.data, model: res.model };
    },
  });

  const rows = samples.map((s) => ({
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    rubric_id: input.rubricId,
    criterion_key: criterion.key,
    sample_idx: s.idx,
    score: s.score,
    evidence: s.evidence,
    rationale: s.rationale,
    extra: {
      feedback: s.feedback,
      ...(s.invalid ? { invalid: true } : {}),
      ...(s.rerun ? { rerun: true } : {}),
      ...(s.unverifiedQuotes.length ? { unverified_quote: true, unverified_quotes: s.unverifiedQuotes } : {}),
      ...(s.injectionInQuotes ? { injection_in_quotes: true } : {}),
    },
    model: s.model,
    prompt_version: input.promptVersion,
    temperature: SAMPLE_TEMPERATURE,
  }));
  const { error: gErr } = await admin
    .from("grades")
    .upsert(rows, { onConflict: "subject_type,subject_id,rubric_id,criterion_key,sample_idx" });
  if (gErr) throw new GradingError(`could not store grades: ${gErr.message}`);

  const injected = samples.filter((s) => s.injectionInQuotes).map((s) => s.idx);
  if (input.signal && injected.length) {
    await logInjectionSignal(admin, input.signal.userId, input.signal.context, {
      where: "grader_quotes",
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      criterion: criterion.key,
      samples: injected,
    });
  }

  const summary = summariseSamples(samples);
  const saved = await upsertSummary(admin, {
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    rubric_id: input.rubricId,
    criterion_key: criterion.key,
    weight: criterion.weight,
    median_score: summary.median,
    spread: summary.spread,
    needs_human_review: summary.needsHumanReview,
    review_reason: summary.reviewReason,
    feedback: summary.feedback,
  });

  return {
    ...summary,
    needsHumanReview: saved.needsHumanReview,
    criterionKey: criterion.key,
    weight: criterion.weight,
    finalScore: saved.finalScore,
    humanScore: saved.humanScore,
    samples,
  };
}

type SummaryFields = {
  subject_type: SubjectType;
  subject_id: string;
  rubric_id: string;
  criterion_key: string;
  weight: number;
  median_score: number | null;
  spread: number | null;
  needs_human_review: boolean;
  review_reason: string | null;
  feedback: string | null;
};

/**
 * Upserts a grade summary. Human fields (human_score/reason/by/at) are never written here,
 * final_score stays the human score when one exists, and a criterion a human has already
 * scored is not flagged for review again (the new review_reason is kept for the record).
 */
export async function upsertSummary(
  admin: SupabaseClient,
  fields: SummaryFields,
): Promise<{ finalScore: number | null; humanScore: number | null; needsHumanReview: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: existing, error } = await admin
      .from("grade_summaries")
      .select("id, human_score")
      .eq("subject_type", fields.subject_type)
      .eq("subject_id", fields.subject_id)
      .eq("criterion_key", fields.criterion_key)
      .maybeSingle();
    if (error) throw new GradingError(`could not read grade summary: ${error.message}`);

    const humanScore = existing?.human_score != null ? Number(existing.human_score) : null;
    const finalScore = humanScore ?? fields.median_score;
    const needsHumanReview = humanScore === null && fields.needs_human_review;
    const row = { ...fields, final_score: finalScore, needs_human_review: needsHumanReview };

    if (existing) {
      const { error: upErr } = await admin.from("grade_summaries").update(row).eq("id", existing.id);
      if (upErr) throw new GradingError(`could not update grade summary: ${upErr.message}`);
      return { finalScore, humanScore, needsHumanReview };
    }
    const { error: insErr } = await admin.from("grade_summaries").insert(row);
    if (!insErr) return { finalScore, humanScore, needsHumanReview };
    if (insErr.code !== "23505") throw new GradingError(`could not insert grade summary: ${insErr.message}`);
    // Lost an insert race; the next pass updates the row the other writer created.
  }
  throw new GradingError("could not upsert grade summary");
}

// ───────────────────────── Handler registry ─────────────────────────

/** Grades one subject end to end (all criteria + any summary on the subject row). */
export type GradingHandler = (admin: SupabaseClient, subjectId: string) => Promise<void>;
type Loader = () => Promise<GradingHandler>;

/**
 * subject_type → handler. Loaders are lazy so handler modules (which import this one) are not
 * a circular import at load time. Wave 3 adds 'submission' with registerGradingLoader.
 */
const registry = new Map<SubjectType, Loader>([
  ["interview", async () => (await import("@/lib/server/interview")).gradeInterviewSession],
]);

export function registerGradingHandler(type: SubjectType, handler: GradingHandler): void {
  registry.set(type, async () => handler);
}

export function registerGradingLoader(type: SubjectType, loader: Loader): void {
  registry.set(type, loader);
}

export function registeredSubjectTypes(): SubjectType[] {
  return [...registry.keys()];
}

async function resolveHandler(type: SubjectType): Promise<GradingHandler | null> {
  const loader = registry.get(type);
  return loader ? loader() : null;
}

// ───────────────────────── Jobs ─────────────────────────

export const MAX_JOB_ATTEMPTS = 3;
const STALE_RUNNING_MS = 10 * 60_000;

export type JobRun = {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  skipped?: boolean;
  error?: string;
};

type JobRow = {
  id: string;
  subject_type: SubjectType;
  subject_id: string;
  status: JobRun["status"];
  attempts: number;
  updated_at: string;
};
const JOB_COLS = "id, subject_type, subject_id, status, attempts, updated_at";

/** Queues (or re-queues) grading for a subject. Returns the job id. */
export async function enqueueGrading(admin: SupabaseClient, subjectType: SubjectType, subjectId: string): Promise<string> {
  const { data, error } = await admin
    .from("grading_jobs")
    .upsert(
      { subject_type: subjectType, subject_id: subjectId, status: "queued", last_error: null },
      { onConflict: "subject_type,subject_id" },
    )
    .select("id")
    .single();
  if (error || !data) throw new GradingError(`could not enqueue grading: ${error?.message ?? "no row"}`);
  return data.id as string;
}

/**
 * Runs one job: claims it (optimistic lock on status + attempts), dispatches to the
 * subject_type handler, and records done/failed. A job another worker is running is skipped
 * unless it is stale.
 */
export async function runGradingJob(admin: SupabaseClient, jobId: string): Promise<JobRun> {
  const { data: job, error } = await admin.from("grading_jobs").select(JOB_COLS).eq("id", jobId).maybeSingle<JobRow>();
  if (error) throw new GradingError(error.message);
  if (!job) throw new GradingError("Grading job not found", 404);
  const base = { id: job.id, subjectType: job.subject_type, subjectId: job.subject_id };

  const stale = Date.now() - new Date(job.updated_at).getTime() > STALE_RUNNING_MS;
  if (job.status === "running" && !stale) return { ...base, status: "running", attempts: job.attempts, skipped: true };

  const attempts = job.attempts + 1;
  const { data: claimed, error: claimErr } = await admin
    .from("grading_jobs")
    .update({ status: "running", attempts, last_error: null })
    .eq("id", job.id)
    .eq("status", job.status)
    .eq("attempts", job.attempts)
    .select("id");
  if (claimErr) throw new GradingError(claimErr.message);
  if (!claimed?.length) return { ...base, status: "running", attempts: job.attempts, skipped: true };

  try {
    const handler = await resolveHandler(job.subject_type);
    if (!handler) throw new Error(`No grading handler registered for ${job.subject_type}`);
    await handler(admin, job.subject_id);
    // Only mark done if nobody re-queued the job while it ran.
    await admin.from("grading_jobs").update({ status: "done" }).eq("id", job.id).eq("status", "running");
    return { ...base, status: "done", attempts };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    console.error("grading job failed", job.id, message);
    await admin.from("grading_jobs").update({ status: "failed", last_error: message }).eq("id", job.id).eq("status", "running");
    return { ...base, status: "failed", attempts, error: message };
  }
}

/**
 * Cron worker: runs queued jobs, failed jobs with attempts left, and stale running jobs, for
 * subject types that have a handler (others stay queued until their handler ships).
 */
export async function runPendingGradingJobs(
  admin: SupabaseClient,
  opts: { limit?: number; subjectType?: SubjectType } = {},
): Promise<JobRun[]> {
  const types = opts.subjectType ? [opts.subjectType] : registeredSubjectTypes();
  if (!types.length) return [];
  const staleBefore = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const { data, error } = await admin
    .from("grading_jobs")
    .select("id")
    .in("subject_type", types)
    .or(
      `status.eq.queued,and(status.eq.failed,attempts.lt.${MAX_JOB_ATTEMPTS}),and(status.eq.running,updated_at.lt."${staleBefore}")`,
    )
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? 3);
  if (error) throw new GradingError(error.message);
  const results: JobRun[] = [];
  for (const j of data ?? []) results.push(await runGradingJob(admin, j.id as string));
  return results;
}

/** Looks up the job for a subject (admin views / re-runs). */
export async function findGradingJob(admin: SupabaseClient, subjectType: SubjectType, subjectId: string) {
  const { data } = await admin
    .from("grading_jobs")
    .select("id, status, attempts, last_error, updated_at")
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .maybeSingle();
  return data;
}
