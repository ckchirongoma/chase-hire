import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import { AiOutputError, chatJson, type ChatJsonResult } from "@/lib/ai";
import { detectInjection } from "@/lib/sanitise";
import {
  collectSamples,
  CriterionGrade,
  EVIDENCE_NUDGE,
  markUnverifiedGaps,
  SAMPLE_TEMPERATURE,
  summariseSamples,
  verifyMappingQuotes,
  verifyRedFlagQuotes,
  type MappingItem,
  type CriterionSummary,
  type RubricCriterion,
  type RubricSubcriterion,
  type SampleOutput,
  type SampleRecord,
  type SubjectType,
} from "@/lib/grading";
import { refreshQuietly, refreshScoresForSubject } from "@/lib/server/scores";
import { gradeCalibration } from "@/lib/calibration/status";

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
  criterion: RubricCriterion | RubricSubcriterion;
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
  // ── Optional extensions (Wave 3 work samples); omitted = Wave 2 behaviour ──
  /** Key stored on grades / grade_summaries (default criterion.key), e.g. "spiky_pov.p1". */
  criterionKey?: string;
  /** Summary weight (default criterion.weight). */
  weight?: number;
  /**
   * Output schema for each sample; must extend CriterionGrade (e.g. ReferenceGrade). Fields beyond
   * CriterionGrade (reference_mapping, red_flags_triggered, extra_valid_gaps) go to grades.extra.
   */
  schema?: z.ZodType;
  /** Per-sample computed score (e.g. 1 + 4 × weighted recall). The judge's own score is kept in extra.llm_score. */
  rescore?: (sample: SampleOutput) => { score: number; extra?: Record<string, unknown> };
  /** Adjusts the summary after aggregation (e.g. per-item medians across samples, red-flag caps). */
  finalise?: (samples: SampleRecord[], summary: CriterionSummary) => { median?: number | null; reviewReasons?: string[] };
  /** Always flag the criterion for a person with these reasons (e.g. "no generic baseline"). */
  reviewReasons?: string[];
  /** Wraps every model call (a limiter shared across criteria caps parallel LLM calls). */
  limit?: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * When the model's output fails schema validation twice (e.g. an incomplete reference_mapping),
   * store an invalid sample (excluded from the median, flagged) instead of failing the whole job.
   */
  invalidOnOutputError?: boolean;
  /** Filters the summary feedback before it is stored (candidate-visible); null withholds it. */
  feedbackFilter?: (feedback: string | null) => string | null;
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
  const criterionKey = input.criterionKey ?? criterion.key;
  const weight = input.weight ?? criterion.weight;
  const limit = input.limit ?? (<T,>(fn: () => Promise<T>) => fn());
  const schema = (input.schema ?? CriterionGrade) as z.ZodType<CriterionGrade & Record<string, unknown>>;
  const subjectText = input.subjectText ?? input.userContent;
  const samples = await collectSamples({
    evidenceRequired: criterion.evidence_required,
    subjectText,
    sample: async (_idx, attempt) => {
      let res: ChatJsonResult<CriterionGrade & Record<string, unknown>>;
      try {
        res = await limit(() =>
          chatJson({
            model: input.model,
            system: input.system,
            user: attempt === 0 ? input.userContent : `${input.userContent}\n\n${EVIDENCE_NUDGE}`,
            schema,
            promptVersion: input.promptVersion,
            temperature: SAMPLE_TEMPERATURE,
          }),
        );
      } catch (err) {
        if (!(input.invalidOnOutputError && err instanceof AiOutputError)) throw err;
        const outputError = err.message.slice(0, 1000);
        return { evidence: [], rationale: `No usable output: ${outputError}`, score: 1, feedback: "", model: input.model, invalid: true, outputError };
      }
      const { evidence, rationale, score, feedback, ...raw } = res.data;
      const rest = verifyExtras(raw, subjectText);
      const out: SampleOutput = { evidence, rationale, score, feedback, model: res.model, ...(Object.keys(rest).length ? { extra: rest } : {}) };
      if (!input.rescore) return out;
      const computed = input.rescore(out);
      return { ...out, score: computed.score, extra: { ...rest, ...computed.extra, llm_score: score } };
    },
  });

  const rows = samples.map((s) => ({
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    rubric_id: input.rubricId,
    criterion_key: criterionKey,
    sample_idx: s.idx,
    score: s.score,
    evidence: s.evidence,
    rationale: s.rationale,
    extra: {
      feedback: s.feedback,
      ...(s.extra ?? {}),
      ...(s.invalid ? { invalid: true } : {}),
      ...(s.rerun ? { rerun: true } : {}),
      ...(s.unverifiedQuotes.length ? { unverified_quote: true, unverified_quotes: s.unverifiedQuotes } : {}),
      ...(s.injectionInQuotes ? { injection_in_quotes: true } : {}),
      ...(s.outputError ? { output_error: s.outputError } : {}),
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
      criterion: criterionKey,
      samples: injected,
    });
  }

  let summary = summariseSamples(samples);
  const reasons = summary.reviewReason ? [summary.reviewReason] : [];
  reasons.push(...extrasReviewReasons(samples));
  if (input.finalise) {
    const f = input.finalise(samples, summary);
    if (f.median !== undefined) summary = { ...summary, median: f.median };
    reasons.push(...(f.reviewReasons ?? []));
  }
  reasons.push(...(input.reviewReasons ?? []));
  // Calibration go-live rule (docs/09 §8.3, lib/calibration/status): a criterion the latest
  // finished gold-set run marked 'review' goes to a person; 'human_only' goes to a person AND its AI
  // score does not count (kept as evidence, final_score waits for a human); a run made with another
  // rubric version, model or prompt is stale and flags every criterion. Gold samples are what
  // calibration measures, so they are graded as they are. With no finished run, nothing changes.
  let aiFinal = true;
  if (input.subjectType !== "gold") {
    const calibration = await gradeCalibration(admin, { rubricId: input.rubricId, criterionKey, model: input.model, promptVersion: input.promptVersion });
    if (calibration.reason) reasons.push(calibration.reason);
    aiFinal = calibration.aiFinal;
  }
  if (reasons.length) summary = { ...summary, needsHumanReview: true, reviewReason: reasons.join("; ") };
  if (input.feedbackFilter) summary = { ...summary, feedback: input.feedbackFilter(summary.feedback) };

  const saved = await upsertSummary(admin, {
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    rubric_id: input.rubricId,
    criterion_key: criterionKey,
    weight,
    median_score: summary.median,
    spread: summary.spread,
    needs_human_review: summary.needsHumanReview,
    review_reason: summary.reviewReason,
    feedback: summary.feedback,
    ai_final: aiFinal,
  });

  return {
    ...summary,
    needsHumanReview: saved.needsHumanReview,
    criterionKey,
    weight,
    finalScore: saved.finalScore,
    humanScore: saved.humanScore,
    samples,
  };
}

/**
 * Checks the quotes behind reference-guided extras (hard rule 4): answer-key items marked found or
 * partial without a quote that appears in the subject get no credit (status "missing", claim kept),
 * red flags without one are dropped, and extra gaps are marked. The ids go to grades.extra.
 */
function verifyExtras(raw: Record<string, unknown>, subjectText: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  if (Array.isArray(raw.reference_mapping)) {
    const v = verifyMappingQuotes(raw.reference_mapping as MappingItem[], subjectText);
    out.reference_mapping = v.mapping;
    if (v.unverified.length) out.unverified_mapping = v.unverified;
  }
  if (Array.isArray(raw.red_flags_triggered)) {
    const v = verifyRedFlagQuotes(raw.red_flags_triggered as { id: string; quote: string }[], subjectText);
    out.red_flags_triggered = v.flags;
    if (v.unverified.length) out.unverified_red_flags = v.unverified;
  }
  if (Array.isArray(raw.extra_valid_gaps)) out.extra_valid_gaps = markUnverifiedGaps(raw.extra_valid_gaps as { gap: string; quote: string }[], subjectText);
  return out;
}

/** Review reasons from sample extras: unusable outputs and unverifiable answer-key claims. */
function extrasReviewReasons(samples: readonly SampleRecord[]): string[] {
  const reasons: string[] = [];
  const failed = samples.filter((s) => s.outputError).length;
  if (failed) reasons.push(`${failed} of ${samples.length} samples returned output that failed validation twice (e.g. an incomplete answer-key mapping)`);
  const valid = samples.filter((s) => !s.invalid);
  const ids = (k: string) => [...new Set(valid.flatMap((s) => (s.extra?.[k] as string[] | undefined) ?? []))].sort();
  const mapping = ids("unverified_mapping");
  if (mapping.length) reasons.push(`Answer-key claims without a quote found in the submission (given no credit): ${mapping.join(", ")}`);
  const flags = ids("unverified_red_flags");
  if (flags.length) reasons.push(`Red flags without a quote found in the submission (not applied): ${flags.join(", ")}`);
  return reasons;
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
  /**
   * false: the AI median is evidence only (calibration 'human_only'), final_score waits for a
   * human score. Omitted: an existing row keeps its value (e.g. a red-flag cap re-upserting a leaf
   * that gradeCriterion stored), a new row counts the AI score.
   */
  ai_final?: boolean;
};

/**
 * Upserts a grade summary. Human fields (human_score/reason/by/at) are never written here,
 * final_score stays the human score when one exists (else the median, unless the criterion is
 * human-scored only), and a criterion a human has already scored is not flagged for review again
 * (the new review_reason is kept for the record).
 */
export async function upsertSummary(
  admin: SupabaseClient,
  fields: SummaryFields,
): Promise<{ finalScore: number | null; humanScore: number | null; needsHumanReview: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: existing, error } = await admin
      .from("grade_summaries")
      .select("id, human_score, ai_final")
      .eq("subject_type", fields.subject_type)
      .eq("subject_id", fields.subject_id)
      .eq("criterion_key", fields.criterion_key)
      .maybeSingle();
    if (error) throw new GradingError(`could not read grade summary: ${error.message}`);

    const humanScore = existing?.human_score != null ? Number(existing.human_score) : null;
    const aiFinal = fields.ai_final ?? (existing ? existing.ai_final !== false : true);
    const finalScore = humanScore ?? (aiFinal ? fields.median_score : null);
    const needsHumanReview = humanScore === null && (fields.needs_human_review || !aiFinal);
    const row = { ...fields, ai_final: aiFinal, final_score: finalScore, needs_human_review: needsHumanReview };

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
export type GradingLoader = () => Promise<GradingHandler>;
type Loader = GradingLoader;

/**
 * subject_type → handler. Loaders are lazy so handler modules (which import this one) are not
 * a circular import at load time. 'submission' (Wave 3 work samples) and 'gold' (calibration) are
 * registered here, so any importer of this module (the cron worker, the admin re-run route, submit
 * routes) can run those jobs; lib/server/grade-submission also registers itself when imported directly.
 */
const registry = new Map<SubjectType, Loader>([
  ["interview", async () => (await import("@/lib/server/interview")).gradeInterviewSession],
  ["submission", async () => (await import("@/lib/server/grade-submission")).submissionGradingHandler],
  // Gold-set calibration (docs/09 §8): grades gold_samples.text_content with the current rubric.
  ["gold", async () => (await import("@/lib/server/calibration")).goldGradingHandler],
]);

export function registerGradingHandler(type: SubjectType, handler: GradingHandler): void {
  registry.set(type, async () => handler);
}

export function registerGradingLoader(type: SubjectType, loader: Loader): void {
  registry.set(type, loader);
}

/** Removes a subject type's handler (tests); returns its loader so registerGradingLoader can restore it. */
export function unregisterGradingHandler(type: SubjectType): GradingLoader | undefined {
  const loader = registry.get(type);
  registry.delete(type);
  return loader;
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

/**
 * Queues (or re-queues) grading for a subject. Returns the job id. A job another worker is
 * running (and not stale) is left alone: resetting it to queued would let a second handler start
 * on the same subject while the first is still writing its grades.
 */
export async function enqueueGrading(admin: SupabaseClient, subjectType: SubjectType, subjectId: string): Promise<string> {
  const staleBefore = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const { data: requeued, error: reErr } = await admin
    .from("grading_jobs")
    .update({ status: "queued", last_error: null })
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .or(`status.neq.running,updated_at.lt."${staleBefore}"`)
    .select("id");
  if (reErr) throw new GradingError(`could not enqueue grading: ${reErr.message}`);
  if (requeued?.length) return requeued[0].id as string;
  const { data: running } = await admin.from("grading_jobs").select("id").eq("subject_type", subjectType).eq("subject_id", subjectId).maybeSingle();
  if (running) return running.id as string;
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
    await refreshQuietly(refreshScoresForSubject(admin, job.subject_type, job.subject_id));
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
