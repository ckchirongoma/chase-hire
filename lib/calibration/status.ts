import type { SupabaseClient } from "@supabase/supabase-js";
import type { CalibrationStatus } from "./stats";

/**
 * How the latest finished calibration run for a rubric applies to a grade (docs/09 §8.3). Used by
 * the grading core for every real (non-gold) grade.
 *
 * What "calibrated" means, explicitly:
 * - NOT CALIBRATED (no finished run for the rubric yet): pre-go-live mode. Grades behave as before
 *   calibration existed: the AI score counts (advisory, as every AI score is) and only the usual
 *   flags apply. The calibration and rubrics pages show "not calibrated". The first finished run
 *   switches the rubric into calibrated mode for good.
 * - CALIBRATED, run matches the grader (same rubric version, model and prompt version):
 *     live       → no calibration flag;
 *     review     → flagged "calibration: review" (the AI score still counts until a person confirms);
 *     human_only → flagged "calibration: human_only" and the AI score does NOT count: the summary
 *                  keeps it as evidence (ai_final false) and final_score waits for a person.
 *   A criterion with too few usable gold samples is human_only (no evidence that it can go live).
 * - CALIBRATED, but the grader changed since the run (rubric version, model or prompt version;
 *   CLAUDE.md: any change needs a gold-set re-run before going live): the old statuses no longer
 *   measure this grader, so nothing is treated as live: every criterion is flagged
 *   "calibration: stale, re-run the gold set (...)", and human_only criteria stay human-only.
 *
 * Takes the caller's client (the service role inside grading jobs).
 */

export type CriterionCalibration = { status: CalibrationStatus; icc: number | null; n: number };

export interface LatestCalibration {
  id: string;
  rubricKey: string;
  rubricVersion: number;
  rubricId: string | null;
  model: string;
  promptVersions: string[];
  finishedAt: string | null;
  passed: boolean | null;
  perCriterion: Record<string, CriterionCalibration>;
}

const STATUSES: readonly string[] = ["live", "review", "human_only"];

export async function latestCalibration(admin: SupabaseClient, rubricKey: string): Promise<LatestCalibration | null> {
  const { data, error } = await admin
    .from("calibration_runs")
    .select("id, rubric_key, rubric_version, rubric_id, model, prompt_versions, finished_at, passed, per_criterion")
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
  return {
    id: run.id,
    rubricKey: run.rubric_key,
    rubricVersion: run.rubric_version,
    rubricId: run.rubric_id ?? null,
    model: run.model,
    promptVersions: Array.isArray(run.prompt_versions) ? run.prompt_versions : [],
    finishedAt: run.finished_at,
    passed: run.passed,
    perCriterion,
  };
}

/** The grader a grade is produced with: compared with the run's to tell a stale calibration. */
export interface CurrentGrader {
  rubricId: string;
  rubricVersion: number;
  model: string;
  promptVersion: string;
}

/** What changed since the run (empty when the run measured this grader). */
export function staleReasons(run: Pick<LatestCalibration, "rubricId" | "rubricVersion" | "model" | "promptVersions">, current: CurrentGrader): string[] {
  const out: string[] = [];
  if ((run.rubricId && run.rubricId !== current.rubricId) || run.rubricVersion !== current.rubricVersion) out.push(`rubric v${run.rubricVersion} → v${current.rubricVersion}`);
  if (run.model !== current.model) out.push(`model ${run.model} → ${current.model}`);
  if (!run.promptVersions.includes(current.promptVersion)) out.push(`prompt ${current.promptVersion} not in the run`);
  return out;
}

export interface GradeCalibration {
  /** null: not calibrated (no run), or the criterion is not calibrated (platform-computed). */
  status: CalibrationStatus | null;
  stale: string[];
  /** The review reason to add ("calibration: …"), or null. */
  reason: string | null;
  /** false: the AI score is evidence only; final_score waits for a person (human-scored only). */
  aiFinal: boolean;
}

/** Pure: how a run applies to one criterion's grade (see the module comment). */
export function calibrationForGrade(run: LatestCalibration | null, criterionKey: string, current: CurrentGrader): GradeCalibration {
  if (!run) return { status: null, stale: [], reason: null, aiFinal: true };
  const status = run.perCriterion[criterionKey]?.status ?? null;
  const stale = staleReasons(run, current);
  if (stale.length) {
    const tag = `calibration: stale, re-run the gold set (${stale.join("; ")})`;
    if (status === "human_only") return { status, stale, reason: `calibration: human_only; ${tag}`, aiFinal: false };
    return { status, stale, reason: tag, aiFinal: true };
  }
  if (status === "review") return { status, stale, reason: "calibration: review", aiFinal: true };
  if (status === "human_only") return { status, stale, reason: "calibration: human_only", aiFinal: false };
  return { status, stale, reason: null, aiFinal: true };
}

/** Reads the rubric and its latest finished run, then applies calibrationForGrade. */
export async function gradeCalibration(
  admin: SupabaseClient,
  input: { rubricId: string; criterionKey: string; model: string; promptVersion: string },
): Promise<GradeCalibration> {
  const { data: rubric, error } = await admin.from("rubrics").select("key, version").eq("id", input.rubricId).maybeSingle();
  if (error) throw new Error(`could not read rubric: ${error.message}`);
  if (!rubric) return { status: null, stale: [], reason: null, aiFinal: true };
  const latest = await latestCalibration(admin, rubric.key as string);
  return calibrationForGrade(latest, input.criterionKey, { rubricId: input.rubricId, rubricVersion: rubric.version as number, model: input.model, promptVersion: input.promptVersion });
}
