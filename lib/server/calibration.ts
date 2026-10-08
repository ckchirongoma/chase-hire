import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { serverEnv } from "@/lib/config";
import { loadPrompt, type LoadedPrompt } from "@/lib/prompts";
import { sanitise, wrapUntrusted } from "@/lib/sanitise";
import {
  answerKeyCoverage,
  consolidateMapping,
  createLimiter,
  CriterionGrade,
  criterionBlock,
  faultPointsToScore,
  gapRecall,
  majorityFlags,
  mapLimit,
  parseBaseline,
  ReferenceGrade,
  referenceGradeFor,
  RubricRow,
  type GraderPrompt,
  type MappingItem,
  type RedFlagRule,
  type RubricCriterion,
  type RubricSubcriterion,
  type SampleOutput,
  type SampleRecord,
} from "@/lib/grading";
import { BundleAAnswerKey, fillFigures } from "@/lib/synth/answer-key";
import { calibrationLeaves, readHumanScores, type CalibrationLeaf } from "@/lib/calibration/criteria";
import { criterionStats, runPassed, type CriterionStats } from "@/lib/calibration/stats";
import { driftAgreement, nextDriftBlock } from "@/lib/calibration/drift";
import { all, inChunks } from "@/lib/server/query";
import { refreshQuietly, refreshScores } from "@/lib/server/scores";
import { enqueueGrading, gradeCriterion, GradingError, MAX_JOB_ATTEMPTS, runGradingJob, type GradingHandler } from "@/lib/server/grading";
import { SUBMISSION_PROMPT_VERSION, SUBMISSION_LLM_CONCURRENCY } from "@/lib/server/grade-submission";

/**
 * Grader calibration (docs/09 §8).
 *
 * - Gold grading ('gold' grading_jobs handler): grades gold_samples.text_content with the CURRENT
 *   active rubric version, the same judge prompts and model as real submissions, through the
 *   shared grading core (gradeCriterion: 3 samples at T=0.3, median, spread, evidence checks).
 *   Rows land in grades / grade_summaries with subject_type 'gold'. Answer-key criteria (gap
 *   recall, A-key coverage, F-key fault points) are scored from the judge's mapping exactly as for
 *   submissions; leaves computed from platform data (elicitation yield, harness checks) are not
 *   calibrated (lib/calibration/criteria).
 * - Calibration runs: grade every gold sample of a rubric, then per criterion ICC(2,1) and
 *   quadratic weighted kappa between the AI final score and the mean of the two human raters
 *   (and human-vs-human ICC for reference), and a go-live status: live (ICC ≥ .75), review
 *   (.60–.75, mandatory human review) or human_only (< .60). The grading core applies the latest
 *   finished run's statuses to new grades (lib/calibration/status), and finishing a run applies
 *   them to the grades already stored (apply_calibration_statuses, migration 0019).
 * - Drift check: 3 random submissions per 25 graded, frozen per block (drift_blocks), re-scored by
 *   a person into drift_rescores, which never change a candidate's score.
 *
 * Everything takes the service-role client; callers check that the user is an admin first.
 */

export class CalibrationError extends Error {}

const SOURCE_CHAR_LIMIT = 60_000;
const BRIEF_CHAR_LIMIT = 8_000;
/** A run still 'running' after this long is treated as abandoned when a new one starts. */
const RUN_STALE_MS = 6 * 60 * 60_000;

const SOURCE_LABEL: Record<string, string> = {
  memo: "MEMO",
  handoff: "HANDOFF PACK",
  transcript: "STAKEHOLDER CHAT TRANSCRIPT",
  loom: "LOOM TRANSCRIPT",
  mvp: "MVP SNAPSHOT (PAGE TEXT)",
  readme: "README.MD",
  release_notes: "RELEASE_NOTES.MD",
  adr: "DOCS/ADR-001.MD",
  harness: "VERIFICATION HARNESS RESULTS",
};

const RubricWithReference = RubricRow.extend({ reference: z.record(z.string(), z.unknown()).nullish().transform((v) => v ?? {}) });
type Rubric = z.output<typeof RubricWithReference>;

type StageRow = {
  key: string;
  title: string;
  brief_md: string | null;
  intended_effort: string | null;
  word_limit: number | null;
  page_limit: number | null;
  dataset_bundle: string | null;
};

export type GoldSampleRow = {
  id: string;
  rubric_key: string;
  label: string;
  file_path: string | null;
  text_content: string;
  human_scores: unknown;
  /** {"1": admin id, "2": admin id}: who owns each human score column. */
  human_raters: unknown;
  created_by: string | null;
  created_at: string;
};
export const GOLD_COLS = "id, rubric_key, label, file_path, text_content, human_scores, human_raters, created_by, created_at";

export type CalibrationRunRow = {
  id: string;
  rubric_key: string;
  rubric_version: number;
  rubric_id: string | null;
  model: string;
  prompt_versions: string[];
  status: "running" | "done" | "failed";
  per_criterion: Record<string, CriterionStats & { title?: string; parent?: string | null }>;
  passed: boolean | null;
  error: string | null;
  ran_by: string | null;
  ran_at: string;
  finished_at: string | null;
  gold_sample_ids: string[];
};
export const RUN_COLS = "id, rubric_key, rubric_version, rubric_id, model, prompt_versions, status, per_criterion, passed, error, ran_by, ran_at, finished_at, gold_sample_ids";

// ───────────────────────── Rubrics ─────────────────────────

/** The active version of a rubric (the highest active version), with its reference blocks. */
export async function currentRubric(admin: SupabaseClient, rubricKey: string): Promise<Rubric> {
  const { data, error } = await admin
    .from("rubrics")
    .select("id, key, version, title, criteria, generic_baseline, reference")
    .eq("key", rubricKey)
    .eq("active", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new CalibrationError(error.message);
  if (!data) throw new CalibrationError(`No active rubric "${rubricKey}"`);
  return RubricWithReference.parse(data);
}

/** Rubric keys that have a work stage (the gold sets are per work rubric). */
export async function workRubricKeys(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin.from("work_stages").select("rubric_key");
  if (error) throw new CalibrationError(error.message);
  return [...new Set((data ?? []).map((r) => r.rubric_key as string))].sort();
}

/** The judge prompt versions a rubric's calibrated leaves use. */
export function promptVersionsFor(leaves: readonly CalibrationLeaf[]): string[] {
  return [...new Set(leaves.map((l) => `${l.criterion.prompt ?? "grader-criterion"}.v${SUBMISSION_PROMPT_VERSION}`))].sort();
}

// ───────────────────────── Reference blocks (as the submission grader renders them) ─────────────────────────

type Item = { id: string; weight: number } & Record<string, unknown>;

function itemsOf(reference: Record<string, unknown>, key: string): { items: Item[]; total: number } {
  const block = reference[key] as { items?: Item[]; total?: number } | undefined;
  const items = (block?.items ?? []).filter((i) => typeof i?.id === "string" && typeof i?.weight === "number");
  return { items, total: typeof block?.total === "number" ? block.total : items.reduce((s, i) => s + i.weight, 0) };
}

function describeItem(i: Item, figures: Record<string, number | string> | null): string {
  const text = fillFigures(String(i.gap ?? i.fact ?? i.fault ?? i.conclusion ?? i.description ?? ""), figures);
  const tags = [i.severity, i.category, `weight ${i.weight}`].filter(Boolean).join(", ");
  const detection = i.detection ? ` (detected by: ${String(i.detection)})` : "";
  return `${i.id} [${tags}]: ${text}${detection}`;
}

function renderBlock(value: unknown, figures: Record<string, number | string> | null): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return fillFigures(value, figures);
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? `- ${fillFigures(v, figures)}` : typeof v === "object" && v && "id" in v ? `- ${(v as { id: string }).id}: ${(v as { description?: string }).description ?? JSON.stringify(v)}` : `- ${JSON.stringify(v)}`))
      .join("\n");
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (Array.isArray(o.items)) {
      const head = [o.total !== undefined ? `Total weight: ${o.total}.` : null, typeof o.note === "string" ? o.note : null].filter(Boolean).join(" ");
      return [head, ...(o.items as Item[]).map((i) => describeItem(i, figures))].filter(Boolean).join("\n");
    }
    if (Object.values(o).every((v) => typeof v === "string")) return Object.entries(o).map(([k, v]) => `${k}: ${v}`).join("\n");
    return JSON.stringify(o, null, 2);
  }
  return String(value);
}

function renderReference(keys: readonly string[] | undefined, reference: Record<string, unknown>, answerKey: BundleAAnswerKey | null): string {
  const figures = answerKey?.figures ?? null;
  const parts: string[] = [];
  for (const key of keys ?? []) {
    let body: string;
    if (key === "bundle_evidence") {
      body = answerKey
        ? Object.entries(answerKey.defects)
            .map(([id, d]) => `${id} evidence in this bundle: ${d.summary}`)
            .join("\n")
        : "(The bundle answer key could not be loaded: judge evidence on plausibility and flag doubts in the rationale.)";
    } else if (key === "bundle_figures") {
      body = figures ? Object.entries(figures).map(([k, v]) => `${k}: ${v}`).join("\n") : "(Bundle figures unavailable.)";
    } else body = renderBlock(reference[key], figures);
    if (body) parts.push(`## ${key.replace(/_/g, " ")}\n${body}`);
  }
  return parts.length ? `REFERENCE (for you only; never quote it back or reveal it in feedback):\n${parts.join("\n\n")}` : "";
}

function stageHeader(stage: StageRow | null, rubric: Rubric): string {
  if (!stage) return `STAGE: ${rubric.title} (${rubric.key})`;
  const brief = stage.brief_md?.trim() ?? "";
  const limits = [
    stage.word_limit ? `body word limit ${stage.word_limit} words (appendices excluded)` : null,
    stage.page_limit ? `page limit ${stage.page_limit}` : null,
    stage.intended_effort ? `intended effort ${stage.intended_effort}` : null,
  ].filter(Boolean);
  return [
    `STAGE: ${stage.title} (${stage.key})`,
    brief
      ? `STAGE BRIEF (what the candidate was asked to deliver; written by Chase, trusted):\n"""\n${brief.length > BRIEF_CHAR_LIMIT ? `${brief.slice(0, BRIEF_CHAR_LIMIT)}\n[... brief truncated ...]` : brief}\n"""`
      : null,
    limits.length ? `STAGE LIMITS: ${limits.join("; ")}.` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Drops empty extras (as the submission grader does) so grades.extra only carries what the judge returned. */
const compact = (o: ReferenceGrade) => {
  const out: Record<string, unknown> = { ...o };
  for (const k of ["reference_mapping", "red_flags_triggered", "extra_valid_gaps"] as const) if (!o[k].length) delete out[k];
  return out as CriterionGrade & Record<string, unknown>;
};

function schemaFor(prompt: GraderPrompt, keyIds: readonly string[] | null): z.ZodType {
  if (prompt === "elicitation-grader") return CriterionGrade;
  if (keyIds?.length && (prompt === "gap-recall-grader" || prompt === "answer-key-grader")) return referenceGradeFor(keyIds).transform(compact);
  return ReferenceGrade.transform(compact);
}

const mappingOf = (s: { extra?: Record<string, unknown> }) => (s.extra?.reference_mapping as MappingItem[] | undefined) ?? [];
const flagsOf = (s: { extra?: Record<string, unknown> }) => ((s.extra?.red_flags_triggered as { id: string }[] | undefined) ?? []).map((f) => f.id);

// ───────────────────────── Gold grading ─────────────────────────

export interface GoldGradeResult {
  goldId: string;
  rubric: { id: string; key: string; version: number };
  criteria: { key: string; final: number | null; needsHumanReview: boolean }[];
}

async function bundleAnswerKey(admin: SupabaseClient, stage: StageRow | null, leaves: readonly CalibrationLeaf[]): Promise<BundleAAnswerKey | null> {
  const needs = leaves.some((l) => (l.criterion.reference_keys ?? []).some((k) => k.startsWith("bundle_")));
  if (!needs || !stage?.dataset_bundle) return null;
  const { data } = await admin.storage.from("datasets").download(`${stage.dataset_bundle.replace(/\/+$/, "")}/internal/answer_key.json`);
  if (!data) return null;
  try {
    const parsed = BundleAAnswerKey.safeParse(JSON.parse(await data.text()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Grades one gold sample on every calibrated leaf of the current rubric. Returns null when the
 * sample no longer exists (deleted since its job was queued).
 */
export async function gradeGoldSample(admin: SupabaseClient, goldId: string, deps: { model?: string } = {}): Promise<GoldGradeResult | null> {
  const { data: gold, error } = await admin.from("gold_samples").select("id, rubric_key, text_content").eq("id", goldId).maybeSingle();
  if (error) throw new GradingError(error.message);
  if (!gold) return null;
  const rubric = await currentRubric(admin, gold.rubric_key as string);
  const { data: stage } = await admin
    .from("work_stages")
    .select("key, title, brief_md, intended_effort, word_limit, page_limit, dataset_bundle")
    .eq("rubric_key", rubric.key)
    .limit(1)
    .maybeSingle<StageRow>();
  const leaves = calibrationLeaves(rubric.criteria);
  if (!leaves.length) throw new GradingError(`Rubric ${rubric.key} has no calibrated criteria`);

  const model = deps.model ?? serverEnv().OPENROUTER_MODEL_GRADER;
  const answerKey = await bundleAnswerKey(admin, stage ?? null, leaves);
  const baseline = parseBaseline(rubric.generic_baseline);
  const header = stageHeader(stage ?? null, rubric);
  const raw = String(gold.text_content ?? "");
  const text = (() => {
    const t = sanitise(raw).text;
    return t.length > SOURCE_CHAR_LIMIT ? `${t.slice(0, SOURCE_CHAR_LIMIT)}\n[... truncated for grading ...]` : t;
  })();
  if (!text.trim()) throw new GradingError("Gold sample has no text to grade");
  const prompts = new Map<GraderPrompt, LoadedPrompt>();
  const prompt = (p: GraderPrompt) => {
    if (!prompts.has(p)) prompts.set(p, loadPrompt(p, SUBMISSION_PROMPT_VERSION));
    return prompts.get(p)!;
  };
  const limit = createLimiter(SUBMISSION_LLM_CONCURRENCY);

  const gradeLeaf = async (leaf: CalibrationLeaf) => {
    const c = leaf.criterion as RubricCriterion | RubricSubcriterion;
    const p = c.prompt ?? "grader-criterion";
    let keyIds: string[] | null = null;
    let rescore: ((s: SampleOutput) => { score: number; extra?: Record<string, unknown> }) | undefined;
    let finalise: ((samples: SampleRecord[]) => { median?: number | null }) | undefined;

    if (c.computation === "gap_recall") {
      const { items, total } = itemsOf(rubric.reference, "gap_key");
      keyIds = items.map((i) => i.id);
      const score = (m: readonly (readonly MappingItem[])[]) => gapRecall(Object.fromEntries(consolidateMapping(m, keyIds!).map((x) => [x.id, x.credit])), items, total);
      rescore = (s) => {
        const r = score([mappingOf(s)]);
        return { score: r.score, extra: { recall: r.recall, points: r.points, max: r.max } };
      };
      finalise = (samples) => {
        const valid = samples.filter((s) => !s.invalid);
        return { median: valid.length ? score(valid.map(mappingOf)).score : null };
      };
    } else if (c.computation === "answer_key") {
      const { items, total } = itemsOf(rubric.reference, "answer_key");
      keyIds = items.map((i) => i.id);
      const rules = (rubric.reference.red_flags as RedFlagRule[] | undefined) ?? [];
      const coverage = (m: readonly (readonly MappingItem[])[], flags: string[]) =>
        answerKeyCoverage(Object.fromEntries(consolidateMapping(m, keyIds!).map((x) => [x.id, x.credit])), items, flags, rules, total);
      rescore = (s) => {
        const r = coverage([mappingOf(s)], flagsOf(s));
        return { score: r.score, extra: { coverage: r.coverage, points: r.points, max: r.max, capped: r.capped } };
      };
      finalise = (samples) => {
        const valid = samples.filter((s) => !s.invalid);
        return { median: valid.length ? coverage(valid.map(mappingOf), majorityFlags(valid.map(flagsOf))).score : null };
      };
    } else if (c.computation === "fault_points") {
      // No harness for a gold sample: the judge's F-key mapping alone, as when a submission has no harness rows.
      const { items } = itemsOf(rubric.reference, "fault_key");
      keyIds = items.map((i) => i.id);
      const points = (m: readonly (readonly MappingItem[])[]) => {
        const credits = new Map(consolidateMapping(m, keyIds!).map((x) => [x.id, x.credit]));
        const p = items.reduce((s, i) => s + i.weight * (credits.get(i.id) ?? 0), 0);
        return { points: p, score: faultPointsToScore(p) };
      };
      rescore = (s) => {
        const r = points([mappingOf(s)]);
        return { score: r.score, extra: { points: r.points, max: 21 } };
      };
      finalise = (samples) => {
        const valid = samples.filter((s) => !s.invalid);
        return { median: valid.length ? points(valid.map(mappingOf)).score : null };
      };
    }

    let baselineBlock = "";
    if (c.baseline && baseline) baselineBlock = `GENERIC_BASELINE (a generic AI answer to this brief, with no data):\n${baseline.answer}`;
    const label = SOURCE_LABEL[c.sources?.[0] ?? "memo"] ?? "SUBMISSION";
    const userContent = [
      header,
      criterionBlock({ ...c, key: leaf.key } as RubricCriterion),
      renderReference(c.reference_keys, rubric.reference, answerKey),
      baselineBlock,
      `SUBMISSION:\n${wrapUntrusted("submission", `[${label}]\n${text}`)}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const loaded = prompt(p);
    const r = await gradeCriterion(admin, {
      subjectType: "gold",
      subjectId: gold.id as string,
      rubricId: rubric.id,
      criterion: c,
      criterionKey: leaf.key,
      system: loaded.system,
      userContent,
      subjectText: text,
      promptVersion: loaded.promptVersion,
      model,
      schema: schemaFor(p, keyIds),
      invalidOnOutputError: Boolean(keyIds?.length),
      rescore,
      finalise,
      limit,
    });
    return { key: leaf.key, final: r.finalScore, needsHumanReview: r.needsHumanReview };
  };

  const criteria = await mapLimit(leaves, SUBMISSION_LLM_CONCURRENCY, gradeLeaf);
  return { goldId: gold.id as string, rubric: { id: rubric.id, key: rubric.key, version: rubric.version }, criteria };
}

/** The grading_jobs handler for subject_type 'gold'. A deleted sample's leftover job is a no-op. */
export const goldGradingHandler: GradingHandler = async (admin, goldId) => {
  const result = await gradeGoldSample(admin, goldId);
  if (!result) return;
  try {
    const { data: runs } = await admin.from("calibration_runs").select("id").eq("status", "running").contains("gold_sample_ids", [goldId]);
    for (const r of runs ?? []) await finishRunIfComplete(admin, r.id as string, { justGraded: goldId });
  } catch (err) {
    // The sample is graded; the page and the next sample retry finishing the run.
    console.error("could not finish calibration run", err instanceof Error ? err.message : err);
  }
};

// ───────────────────────── Runs ─────────────────────────

export async function loadRun(admin: SupabaseClient, runId: string): Promise<CalibrationRunRow | null> {
  const { data, error } = await admin.from("calibration_runs").select(RUN_COLS).eq("id", runId).maybeSingle<CalibrationRunRow>();
  if (error) throw new CalibrationError(error.message);
  return data;
}

/**
 * Starts a run for one rubric: records the rubric version, model and prompt versions, and queues
 * a 'gold' grading job for every gold sample of that rubric. Refuses while a recent run is going.
 */
export async function startCalibrationRun(admin: SupabaseClient, rubricKey: string, ranBy: string | null): Promise<CalibrationRunRow> {
  const rubric = await currentRubric(admin, rubricKey);
  const leaves = calibrationLeaves(rubric.criteria);
  if (!leaves.length) throw new CalibrationError(`Rubric ${rubricKey} has no criteria the AI judge scores.`);
  const samples = await all<{ id: string }>((f, t) => admin.from("gold_samples").select("id").eq("rubric_key", rubricKey).order("created_at").order("id").range(f, t));
  if (!samples.length) throw new CalibrationError("Add gold samples before running the graders on the gold set.");

  const { data: running, error: rErr } = await admin.from("calibration_runs").select("id, ran_at").eq("rubric_key", rubricKey).eq("status", "running");
  if (rErr) throw new CalibrationError(rErr.message);
  for (const r of running ?? []) {
    if (Date.now() - new Date(r.ran_at as string).getTime() < RUN_STALE_MS) throw new CalibrationError("A calibration run for this rubric is still in progress: continue or finish it first.");
    await admin.from("calibration_runs").update({ status: "failed", error: "abandoned: a newer run was started", finished_at: new Date().toISOString() }).eq("id", r.id).eq("status", "running");
  }

  const { data: run, error } = await admin
    .from("calibration_runs")
    .insert({
      rubric_key: rubric.key,
      rubric_version: rubric.version,
      rubric_id: rubric.id,
      model: serverEnv().OPENROUTER_MODEL_GRADER,
      prompt_versions: promptVersionsFor(leaves),
      status: "running",
      ran_by: ranBy,
      gold_sample_ids: samples.map((s) => s.id),
    })
    .select(RUN_COLS)
    .single<CalibrationRunRow>();
  if (error || !run) throw new CalibrationError(error?.message ?? "Could not start the run");
  for (const s of samples) await enqueueGrading(admin, "gold", s.id);
  return run;
}

type JobRow = { id: string; subject_id: string; status: string; attempts: number; updated_at: string };

async function runJobs(admin: SupabaseClient, run: CalibrationRunRow): Promise<JobRow[]> {
  return inChunks<JobRow>(run.gold_sample_ids, (c) => admin.from("grading_jobs").select("id, subject_id, status, attempts, updated_at").eq("subject_type", "gold").in("subject_id", c));
}

export interface RunProgress {
  total: number;
  graded: number;
  failed: number;
  pending: number;
}

function progressOf(run: CalibrationRunRow, jobs: readonly JobRow[], justGraded?: string): RunProgress & { doneIds: Set<string> } {
  const byId = new Map(jobs.map((j) => [j.subject_id, j]));
  const since = new Date(run.ran_at).getTime();
  const doneIds = new Set<string>();
  let failed = 0;
  for (const id of run.gold_sample_ids) {
    const j = byId.get(id);
    if (id === justGraded || (j?.status === "done" && new Date(j.updated_at).getTime() >= since)) doneIds.add(id);
    else if (j?.status === "failed" && j.attempts >= MAX_JOB_ATTEMPTS) failed++;
  }
  const total = run.gold_sample_ids.length;
  return { total, graded: doneIds.size, failed, pending: total - doneIds.size - failed, doneIds };
}

export async function runProgress(admin: SupabaseClient, run: CalibrationRunRow): Promise<RunProgress> {
  const { total, graded, failed, pending } = progressOf(run, await runJobs(admin, run));
  return { total, graded, failed, pending };
}

/**
 * Runs this run's pending gold jobs one at a time until none are left or the time budget is
 * spent (the rest continue on the grading worker, or on "Continue"), then finishes the run if
 * every sample is graded.
 */
export async function processCalibrationRun(admin: SupabaseClient, runId: string, budgetMs = 100_000): Promise<{ run: CalibrationRunRow; progress: RunProgress }> {
  const started = Date.now();
  let run = await loadRun(admin, runId);
  if (!run) throw new CalibrationError("Calibration run not found");
  const tried = new Set<string>();
  while (run.status === "running" && Date.now() - started < budgetMs) {
    const jobs = await runJobs(admin, run);
    const p = progressOf(run, jobs);
    const next = jobs.find(
      (j) =>
        !p.doneIds.has(j.subject_id) &&
        !tried.has(j.id) &&
        (j.status === "queued" || (j.status === "failed" && j.attempts < MAX_JOB_ATTEMPTS) || (j.status === "done" && !p.doneIds.has(j.subject_id))),
    );
    if (!next) break;
    tried.add(next.id);
    if (next.status === "done") await enqueueGrading(admin, "gold", next.subject_id); // graded before this run started
    await runGradingJob(admin, next.id);
    run = (await loadRun(admin, runId))!;
  }
  if (run.status === "running") run = await finishRunIfComplete(admin, runId);
  return { run, progress: await runProgress(admin, run) };
}

/**
 * Computes the report and closes the run once every sample is graded (or has failed for good).
 * `force` closes it with whatever is graded. A run where nothing could be graded fails.
 */
export async function finishRunIfComplete(admin: SupabaseClient, runId: string, opts: { force?: boolean; justGraded?: string } = {}): Promise<CalibrationRunRow> {
  const run = await loadRun(admin, runId);
  if (!run) throw new CalibrationError("Calibration run not found");
  if (run.status !== "running") return run;
  const p = progressOf(run, await runJobs(admin, run), opts.justGraded);
  if (p.pending > 0 && !opts.force) return run;
  const finishedAt = new Date().toISOString();
  if (p.graded === 0) {
    const { data } = await admin
      .from("calibration_runs")
      .update({ status: "failed", error: "No gold sample could be graded.", finished_at: finishedAt })
      .eq("id", run.id)
      .eq("status", "running")
      .select(RUN_COLS)
      .maybeSingle<CalibrationRunRow>();
    if (data && p.pending) await dropPendingGoldJobs(admin, run);
    return data ?? (await loadRun(admin, runId))!;
  }
  const perCriterion = await computeRunStats(admin, run, p.doneIds);
  const notes = [p.failed ? `${p.failed} gold sample(s) could not be graded` : null, p.pending ? `${p.pending} gold sample(s) were not graded (finished early)` : null].filter(Boolean);
  const { data } = await admin
    .from("calibration_runs")
    .update({ status: "done", per_criterion: perCriterion, passed: runPassed(perCriterion), error: notes.length ? notes.join("; ") : null, finished_at: finishedAt })
    .eq("id", run.id)
    .eq("status", "running")
    .select(RUN_COLS)
    .maybeSingle<CalibrationRunRow>();
  if (data) {
    if (p.pending) await dropPendingGoldJobs(admin, run);
    await applyRunStatuses(admin, data.id);
  }
  return data ?? (await loadRun(admin, runId))!;
}

/**
 * Applies a finished run's go-live statuses to the real grades already stored (docs/09 §8.3):
 * 'review' and 'human_only' flag them, 'human_only' also takes the AI score out of final_score
 * until a person scores it, 'live' lets it count again. Then refreshes the composites of the
 * applications whose stage scores changed.
 */
export async function applyRunStatuses(admin: SupabaseClient, runId: string): Promise<string[]> {
  const { data, error } = await admin.rpc("apply_calibration_statuses", { p_run_id: runId });
  if (error) throw new CalibrationError(`could not apply the calibration statuses: ${error.message}`);
  const ids = [...new Set(((data ?? []) as unknown[]).map((x) => (typeof x === "string" ? x : String((x as Record<string, unknown>)?.apply_calibration_statuses ?? ""))).filter(Boolean))];
  if (ids.length) await refreshQuietly(refreshScores(admin, ids));
  return ids;
}

/**
 * A closed run's gold jobs that have not started (queued, or failed with retries left) are
 * removed, so the grading worker doesn't spend LLM calls on results nobody uses. A job that is
 * running finishes; its handler finds no running run and stops there.
 */
async function dropPendingGoldJobs(admin: SupabaseClient, run: Pick<CalibrationRunRow, "gold_sample_ids">): Promise<void> {
  for (let i = 0; i < run.gold_sample_ids.length; i += 100) {
    const chunk = run.gold_sample_ids.slice(i, i + 100);
    const { error } = await admin.from("grading_jobs").delete().eq("subject_type", "gold").in("subject_id", chunk).in("status", ["queued", "failed"]);
    if (error) console.warn("could not drop pending gold jobs", error.message);
  }
}

/** Per calibrated criterion: AI final (this run's grading) vs the two humans. */
export async function computeRunStats(admin: SupabaseClient, run: CalibrationRunRow, gradedIds: ReadonlySet<string>): Promise<CalibrationRunRow["per_criterion"]> {
  const { data: rubricRow, error } = await admin
    .from("rubrics")
    .select("id, key, version, title, criteria, generic_baseline, reference")
    .eq(run.rubric_id ? "id" : "key", run.rubric_id ?? run.rubric_key)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !rubricRow) throw new CalibrationError(error?.message ?? "Rubric not found");
  const rubric = RubricWithReference.parse(rubricRow);
  const leaves = calibrationLeaves(rubric.criteria);
  const ids = run.gold_sample_ids.filter((id) => gradedIds.has(id));
  const [samples, summaries] = await Promise.all([
    inChunks<{ id: string; human_scores: unknown }>(ids, (c) => admin.from("gold_samples").select("id, human_scores").in("id", c)),
    inChunks<{ subject_id: string; criterion_key: string; final_score: number | null; updated_at: string }>(ids, (c) =>
      admin.from("grade_summaries").select("subject_id, criterion_key, final_score, updated_at").eq("subject_type", "gold").eq("rubric_id", rubric.id).in("subject_id", c),
    ),
  ]);
  const since = new Date(run.ran_at).getTime();
  const ai = new Map<string, number>();
  for (const s of summaries) {
    if (s.final_score === null || new Date(s.updated_at).getTime() < since) continue;
    ai.set(`${s.subject_id}|${s.criterion_key}`, Number(s.final_score));
  }
  const humans = new Map(samples.map((s) => [s.id, readHumanScores(s.human_scores)]));
  const out: CalibrationRunRow["per_criterion"] = {};
  for (const leaf of leaves) {
    const stats = criterionStats(
      ids.map((id) => ({ goldId: id, ai: ai.get(`${id}|${leaf.key}`) ?? null, human: humans.get(id)?.[leaf.key] ?? [null, null] })),
    );
    out[leaf.key] = { ...stats, title: leaf.title, parent: leaf.parentTitle };
  }
  return out;
}

/** Closes any running run whose samples are all graded (the page calls this; it is idempotent). */
export async function syncCalibrationRuns(admin: SupabaseClient): Promise<void> {
  const { data } = await admin.from("calibration_runs").select("id").eq("status", "running");
  for (const r of data ?? []) await finishRunIfComplete(admin, r.id as string);
}

export async function cancelCalibrationRun(admin: SupabaseClient, runId: string, by: string): Promise<void> {
  const { data, error } = await admin
    .from("calibration_runs")
    .update({ status: "failed", error: `cancelled by an admin (${by.slice(0, 8)})`, finished_at: new Date().toISOString() })
    .eq("id", runId)
    .eq("status", "running")
    .select("gold_sample_ids");
  if (error) throw new CalibrationError(error.message);
  for (const r of data ?? []) await dropPendingGoldJobs(admin, r as Pick<CalibrationRunRow, "gold_sample_ids">);
}

// ───────────────────────── Drift check ─────────────────────────

export interface DriftPick {
  submissionId: string;
  /** Null when the submission no longer exists (retention purge). */
  userId: string | null;
  createdAt: string | null;
  /** Criteria the viewer has re-scored for this pick, and criteria anyone has. */
  rescoredByMe: number;
  rescored: number;
}

export interface DriftReport {
  rubricKey: string;
  graded: number;
  /** Graded submissions not yet in a frozen block (the next block freezes at 25). */
  waiting: number;
  blocks: {
    block: number;
    frozenAt: string;
    picks: DriftPick[];
    agreement: { n: number; within1: number | null; mad: number | null };
  }[];
}

export type DriftBlockRow = { block: number; submission_ids: string[]; pick_ids: string[]; created_at: string };

async function frozenBlocks(admin: SupabaseClient, rubricKey: string): Promise<DriftBlockRow[]> {
  const { data, error } = await admin.from("drift_blocks").select("block, submission_ids, pick_ids, created_at").eq("rubric_key", rubricKey).order("block");
  if (error) throw new CalibrationError(error.message);
  return (data ?? []) as DriftBlockRow[];
}

/**
 * Freezes every complete block of 25 graded submissions (oldest first) not yet in a block, one at a
 * time, and returns all the rubric's blocks. A concurrent page load that froze a block first wins,
 * and nothing frozen ever changes: a re-grade, a purge or a late grade only affects later blocks.
 */
export async function freezeDriftBlocks(admin: SupabaseClient, rubricKey: string, graded: readonly { id: string }[]): Promise<DriftBlockRow[]> {
  let blocks = await frozenBlocks(admin, rubricKey);
  for (let guard = 0; guard < 1000; guard++) {
    const frozen = new Set(blocks.flatMap((b) => b.submission_ids));
    const number = (blocks.at(-1)?.block ?? 0) + 1;
    const next = nextDriftBlock(graded.filter((x) => !frozen.has(x.id)), rubricKey, number);
    if (!next) break;
    const { error } = await admin
      .from("drift_blocks")
      .upsert({ rubric_key: rubricKey, block: number, submission_ids: next.submissionIds, pick_ids: next.pickIds }, { onConflict: "rubric_key,block", ignoreDuplicates: true });
    if (error) throw new CalibrationError(error.message);
    blocks = await frozenBlocks(admin, rubricKey);
  }
  return blocks;
}

/**
 * Drift check for a rubric (docs/09 §8.4). Graded submissions are frozen into blocks of 25 as they
 * fill (drift_blocks: the block's submissions and its 3 seeded picks never change afterwards), and
 * agreement is computed from drift re-scores only (drift_rescores: a person's 1–5 per criterion vs
 * the AI median), which never change a candidate's score. Service-role client after an admin check.
 */
export async function driftReport(admin: SupabaseClient, rubricKey: string, viewerId?: string): Promise<DriftReport> {
  const { data: stages, error } = await admin.from("work_stages").select("key").eq("rubric_key", rubricKey);
  if (error) throw new CalibrationError(error.message);
  const stageKeys = (stages ?? []).map((s) => s.key as string);
  const subs = stageKeys.length
    ? await all<{ id: string }>((f, t) =>
        admin.from("submissions").select("id").in("stage_key", stageKeys).in("grading_status", ["done", "needs_review"]).order("created_at").order("id").range(f, t),
      )
    : [];
  const blocks = await freezeDriftBlocks(admin, rubricKey, subs);
  const frozen = new Set(blocks.flatMap((b) => b.submission_ids));

  const pickIds = [...new Set(blocks.flatMap((b) => b.pick_ids))];
  const [info, rescores, medians] = await Promise.all([
    inChunks<{ id: string; user_id: string; created_at: string }>(pickIds, (c) => admin.from("submissions").select("id, user_id, created_at").in("id", c)),
    inChunks<{ submission_id: string; criterion_key: string; score: number; rater: string }>(pickIds, (c) =>
      admin.from("drift_rescores").select("submission_id, criterion_key, score, rater").eq("rubric_key", rubricKey).in("submission_id", c),
    ),
    inChunks<{ subject_id: string; criterion_key: string; median_score: number | null }>(pickIds, (c) =>
      admin.from("grade_summaries").select("subject_id, criterion_key, median_score").eq("subject_type", "submission").in("subject_id", c),
    ),
  ]);
  const sub = new Map(info.map((x) => [x.id, x]));
  const ai = new Map(medians.filter((m) => m.median_score !== null).map((m) => [`${m.subject_id}|${m.criterion_key}`, Number(m.median_score)]));
  const bySub = new Map<string, typeof rescores>();
  for (const r of rescores) bySub.set(r.submission_id, [...(bySub.get(r.submission_id) ?? []), r]);

  return {
    rubricKey,
    graded: subs.length,
    waiting: subs.filter((x) => !frozen.has(x.id)).length,
    blocks: blocks.map((b) => {
      const pairs: { ai: number; human: number }[] = [];
      const picks = b.pick_ids.map((id): DriftPick => {
        const rs = bySub.get(id) ?? [];
        for (const r of rs) {
          const a = ai.get(`${id}|${r.criterion_key}`);
          if (a !== undefined) pairs.push({ ai: a, human: Number(r.score) });
        }
        return {
          submissionId: id,
          userId: sub.get(id)?.user_id ?? null,
          createdAt: sub.get(id)?.created_at ?? null,
          rescoredByMe: viewerId ? new Set(rs.filter((r) => r.rater === viewerId).map((r) => r.criterion_key)).size : 0,
          rescored: new Set(rs.map((r) => r.criterion_key)).size,
        };
      });
      return { block: b.block, frozenAt: b.created_at, picks, agreement: driftAgreement(pairs) };
    }),
  };
}

/** Whether a submission is a drift pick for a rubric (only picks are re-scored for drift). */
export async function isDriftPick(admin: SupabaseClient, rubricKey: string, submissionId: string): Promise<boolean> {
  const { data, error } = await admin.from("drift_blocks").select("block").eq("rubric_key", rubricKey).contains("pick_ids", [submissionId]).limit(1);
  if (error) throw new CalibrationError(error.message);
  return Boolean(data?.length);
}
