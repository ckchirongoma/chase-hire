import type { SupabaseClient } from "@supabase/supabase-js";
import type { CalibrationStatus } from "./stats";

/**
 * The go-live status of each criterion, from the latest finished calibration run for a rubric
 * (docs/09 §8.3). Used by the grading core: a criterion marked 'review' or 'human_only' is flagged
 * for a person on every grade. With no finished run yet, nothing is flagged (today's behaviour).
 * Takes the caller's client (the service role inside grading jobs).
 */

export type CriterionCalibration = { status: CalibrationStatus; icc: number | null; n: number };

export interface LatestCalibration {
  id: string;
  rubricKey: string;
  rubricVersion: number;
  finishedAt: string | null;
  passed: boolean | null;
  perCriterion: Record<string, CriterionCalibration>;
}

const STATUSES: readonly string[] = ["live", "review", "human_only"];

export async function latestCalibration(admin: SupabaseClient, rubricKey: string): Promise<LatestCalibration | null> {
  const { data, error } = await admin
    .from("calibration_runs")
    .select("id, rubric_key, rubric_version, finished_at, passed, per_criterion")
    .eq("rubric_key", rubricKey)
    .eq("status", "done")
    .order("finished_at", { ascending: false, nullsFirst: false })
    .order("ran_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`could not read calibration runs: ${error.message}`);
  const run = data?.[0];
  if (!run) return null;
  const perCriterion: Record<string, CriterionCalibration> = {};
  for (const [key, v] of Object.entries((run.per_criterion ?? {}) as Record<string, { status?: unknown; icc?: unknown; n?: unknown }>)) {
    if (typeof v?.status === "string" && STATUSES.includes(v.status)) {
      perCriterion[key] = { status: v.status as CalibrationStatus, icc: typeof v.icc === "number" ? v.icc : null, n: typeof v.n === "number" ? v.n : 0 };
    }
  }
  return { id: run.id, rubricKey: run.rubric_key, rubricVersion: run.rubric_version, finishedAt: run.finished_at, passed: run.passed, perCriterion };
}

/** "calibration: review" / "calibration: human_only" for a criterion that may not be AI-scored alone; else null. */
export async function calibrationReviewReason(admin: SupabaseClient, rubricId: string, criterionKey: string): Promise<string | null> {
  const { data: rubric, error } = await admin.from("rubrics").select("key").eq("id", rubricId).maybeSingle();
  if (error) throw new Error(`could not read rubric: ${error.message}`);
  if (!rubric) return null;
  const latest = await latestCalibration(admin, rubric.key as string);
  const status = latest?.perCriterion[criterionKey]?.status;
  return status === "review" || status === "human_only" ? `calibration: ${status}` : null;
}
