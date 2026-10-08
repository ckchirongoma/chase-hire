"use server";
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { RubricRow } from "@/lib/grading/schema";
import { calibrationLeaves, HumanScores, humanScoresFromForm, readHumanScores } from "@/lib/calibration/criteria";
import { readDocument } from "@/lib/work/documents";
import { EXT_MIME, TEXT_EXTS, type FileExt } from "@/lib/work/stages";
import { storableText } from "@/lib/work/text";
import { cancelCalibrationRun, CalibrationError, finishRunIfComplete, processCalibrationRun, startCalibrationRun } from "@/lib/server/calibration";

/**
 * Gold-set management and calibration runs (docs/09 §8). Gold samples are written through the
 * admin's own client (RLS: admins only). Runs and grades are written by the service role after the
 * admin check (calibration_runs has no client write policy). A run grades every gold sample with
 * the CURRENT rubric, prompts and model through the normal grader, then reports agreement.
 */

const GOLD_MAX_BYTES = 10 * 1024 * 1024;
const TEXT_MIN = 50;
const TEXT_MAX = 200_000;
/** Time a run spends grading inline before handing the rest to the grading worker ("Continue"). */
const INLINE_BUDGET_MS = 100_000;

const go = (path: string, params: Record<string, string>, extra = ""): never => redirect(`${path}?${new URLSearchParams(params)}${extra ? `&${extra}` : ""}`);
const rubricPage = (key: string) => `/admin/calibration`.concat(key ? `?rubric=${encodeURIComponent(key)}` : "");
const goRubric = (key: string, params: Record<string, string>): never => redirect(`${rubricPage(key)}${key ? "&" : "?"}${new URLSearchParams(params)}`);

const RubricKey = z.string().regex(/^[a-z0-9_]{1,40}$/, "Unknown rubric.");

async function activeRubric(supabase: Awaited<ReturnType<typeof requireAdmin>>["supabase"], key: string) {
  const { data } = await supabase
    .from("rubrics")
    .select("id, key, version, title, criteria, generic_baseline")
    .eq("key", key)
    .eq("active", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? RubricRow.parse(data) : null;
}

// ───────────────────────── Gold samples ─────────────────────────

const NewGold = z.object({
  rubric_key: RubricKey,
  label: z.string().trim().min(2, "Give the sample a label (e.g. weak, strong, doc 13 reference).").max(120),
  text: z.string().max(TEXT_MAX * 2).optional(),
});

export async function addGoldSample(formData: FormData) {
  const { supabase, user } = await requireAdmin();
  const parsed = NewGold.safeParse({ rubric_key: formData.get("rubric_key"), label: formData.get("label"), text: formData.get("text") ?? undefined });
  if (!parsed.success) go("/admin/calibration", { error: parsed.error.issues[0].message });
  const { rubric_key, label } = parsed.data!;
  if (!(await activeRubric(supabase, rubric_key))) go("/admin/calibration", { error: "Unknown rubric." });

  let text = storableText(parsed.data!.text ?? "").trim();
  let filePath: string | null = null;
  const file = formData.get("file");
  if (file instanceof File && file.size > 0) {
    const ext = (file.name.split(".").pop() ?? "").toLowerCase() as FileExt;
    if (!TEXT_EXTS.includes(ext)) goRubric(rubric_key, { error: "Upload a .txt, .md, .docx or .pdf file." });
    if (file.size > GOLD_MAX_BYTES) goRubric(rubric_key, { error: "The file is larger than 10 MB." });
    const buf = Buffer.from(await file.arrayBuffer());
    let fileText = "";
    try {
      fileText = (await readDocument(buf, ext)).text.trim();
    } catch {
      goRubric(rubric_key, { error: "Could not read text from that file." });
    }
    if (!fileText) goRubric(rubric_key, { error: "That file has no text layer (a scanned PDF?). Paste the text instead." });
    text = text ? `${text}\n\n${fileText}` : fileText;
    const path = `${rubric_key}/${randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage.from("gold").upload(path, buf, { contentType: EXT_MIME[ext], upsert: false });
    if (!upErr) filePath = path;
  }
  if (text.length < TEXT_MIN) goRubric(rubric_key, { error: `Paste the submission text or upload a file (at least ${TEXT_MIN} characters).` });
  if (text.length > TEXT_MAX) goRubric(rubric_key, { error: `The text is longer than ${TEXT_MAX.toLocaleString("en-US")} characters.` });

  const { data, error } = await supabase
    .from("gold_samples")
    .insert({ rubric_key, label, text_content: text, file_path: filePath, created_by: user.id, human_scores: {} })
    .select("id")
    .single();
  if (error || !data) goRubric(rubric_key, { error: error?.message ?? "Could not save the gold sample." });
  redirect(`/admin/calibration/gold/${data!.id}?ok=${encodeURIComponent("Gold sample added. Two people now score it independently.")}`);
}

const EditGold = z.object({
  gold_id: z.uuid(),
  label: z.string().trim().min(2).max(120),
  text: z.string().transform((s) => storableText(s).trim()).pipe(z.string().min(TEXT_MIN, `At least ${TEXT_MIN} characters.`).max(TEXT_MAX)),
});

export async function updateGoldSample(formData: FormData) {
  const { supabase } = await requireAdmin();
  const parsed = EditGold.safeParse(Object.fromEntries(formData));
  const id = String(formData.get("gold_id") ?? "");
  const back = z.uuid().safeParse(id).success ? `/admin/calibration/gold/${id}` : "/admin/calibration";
  if (!parsed.success) go(back, { error: parsed.error.issues[0].message });
  const { data, error } = await supabase.from("gold_samples").update({ label: parsed.data!.label, text_content: parsed.data!.text }).eq("id", parsed.data!.gold_id).select("id");
  if (error) go(back, { error: error.message });
  if (!data?.length) go("/admin/calibration", { error: "Gold sample not found." });
  go(back, { ok: "Saved. Re-run the graders on the gold set for the change to count." });
}

/**
 * One human rater's 1–5 scores per calibrated criterion (blank = not scored yet). Each rater saves
 * only their own column, so the two scores stay independent.
 */
export async function saveHumanScores(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = String(formData.get("gold_id") ?? "");
  if (!z.uuid().safeParse(id).success) go("/admin/calibration", { error: "Gold sample not found." });
  const back = `/admin/calibration/gold/${id}`;
  const raterField = formData.get("rater");
  if (raterField !== "1" && raterField !== "2") go(back, { error: "Choose rater 1 or rater 2." });
  const rater: 1 | 2 = raterField === "2" ? 2 : 1;
  const { data: gold, error } = await supabase.from("gold_samples").select("id, rubric_key, human_scores").eq("id", id).maybeSingle();
  if (error) go(back, { error: error.message });
  if (!gold) go("/admin/calibration", { error: "Gold sample not found." });
  const rubric = await activeRubric(supabase, gold!.rubric_key as string);
  if (!rubric) go(back, { error: "The rubric is not active." });
  const keys = calibrationLeaves(rubric!.criteria).map((l) => l.key);
  const fields = Object.fromEntries([...formData.entries()].filter(([k]) => k.startsWith(`h${rater}:`)));
  const { scores, invalid } = humanScoresFromForm(fields, keys);
  if (invalid.length) go(back, { error: `Scores must be whole numbers from 1 to 5 (${invalid.join(", ")}).` }, `rater=${rater}`);
  // Only this rater's slot changes; the other rater's scores and keys of older rubric versions are kept.
  const current = readHumanScores(gold!.human_scores);
  const next: Record<string, [number | null, number | null]> = { ...current };
  for (const k of keys) {
    const mine = scores[k]?.[rater - 1] ?? null;
    const pair: [number | null, number | null] = [...(current[k] ?? [null, null])] as [number | null, number | null];
    pair[rater - 1] = mine;
    if (pair[0] === null && pair[1] === null) delete next[k];
    else next[k] = pair;
  }
  const merged = HumanScores.safeParse(next);
  if (!merged.success) go(back, { error: "Invalid scores." });
  const { error: upErr } = await supabase.from("gold_samples").update({ human_scores: merged.data }).eq("id", id);
  if (upErr) go(back, { error: upErr.message });
  go(back, { ok: `Rater ${rater}'s scores saved.` }, `rater=${rater}`);
}

export async function deleteGoldSample(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = String(formData.get("gold_id") ?? "");
  if (!z.uuid().safeParse(id).success || formData.get("confirm") !== "delete") go(`/admin/calibration/gold/${id}`, { error: 'Type "delete" to confirm.' });
  const { data, error } = await supabase.from("gold_samples").delete().eq("id", id).select("rubric_key, file_path");
  if (error) go(`/admin/calibration/gold/${id}`, { error: error.message });
  if (!data?.length) go("/admin/calibration", { error: "Gold sample not found." });
  // Its grades and grading job go too (service role: these tables have no client delete policy).
  const service = createAdminClient();
  await service.from("grades").delete().eq("subject_type", "gold").eq("subject_id", id);
  await service.from("grade_summaries").delete().eq("subject_type", "gold").eq("subject_id", id);
  await service.from("grading_jobs").delete().eq("subject_type", "gold").eq("subject_id", id);
  if (data![0].file_path) await service.storage.from("gold").remove([data![0].file_path as string]);
  goRubric(data![0].rubric_key as string, { ok: "Gold sample deleted." });
}

// ───────────────────────── Runs ─────────────────────────

function progressMessage(p: { total: number; graded: number; failed: number; pending: number }, status: string, passed: boolean | null): string {
  if (status === "done") return `Calibration finished: ${p.graded} of ${p.total} gold samples graded. ${passed ? "Every criterion meets the go-live rule." : "Not every criterion is live: see the report."}`;
  if (status === "failed") return "The calibration run failed: no gold sample could be graded.";
  return `Grading the gold set: ${p.graded} of ${p.total} graded${p.failed ? `, ${p.failed} failed` : ""}. The rest continue on the grading worker, or press Continue.`;
}

export async function runCalibration(formData: FormData) {
  const { user } = await requireAdmin();
  const parsed = RubricKey.safeParse(formData.get("rubric_key"));
  if (!parsed.success) go("/admin/calibration", { error: "Unknown rubric." });
  const key = parsed.data!;
  const admin = createAdminClient();
  let message: string;
  try {
    const run = await startCalibrationRun(admin, key, user.id);
    const { run: after, progress } = await processCalibrationRun(admin, run.id, INLINE_BUDGET_MS);
    message = progressMessage(progress, after.status, after.passed);
  } catch (err) {
    goRubric(key, { error: err instanceof CalibrationError ? err.message : `Calibration failed: ${err instanceof Error ? err.message : String(err)}` });
  }
  goRubric(key, { ok: message! });
}

const RunId = z.object({ run_id: z.uuid(), rubric_key: RubricKey });

export async function continueCalibration(formData: FormData) {
  await requireAdmin();
  const parsed = RunId.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go("/admin/calibration", { error: "Unknown run." });
  let message: string;
  try {
    const { run, progress } = await processCalibrationRun(createAdminClient(), parsed.data!.run_id, INLINE_BUDGET_MS);
    message = progressMessage(progress, run.status, run.passed);
  } catch (err) {
    goRubric(parsed.data!.rubric_key, { error: err instanceof Error ? err.message : String(err) });
  }
  goRubric(parsed.data!.rubric_key, { ok: message! });
}

/** Closes a run with whatever is graded (e.g. a sample keeps failing). */
export async function finishCalibration(formData: FormData) {
  await requireAdmin();
  const parsed = RunId.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go("/admin/calibration", { error: "Unknown run." });
  let status = "";
  try {
    status = (await finishRunIfComplete(createAdminClient(), parsed.data!.run_id, { force: true })).status;
  } catch (err) {
    goRubric(parsed.data!.rubric_key, { error: err instanceof Error ? err.message : String(err) });
  }
  goRubric(parsed.data!.rubric_key, { ok: status === "done" ? "Run finished with the samples graded so far." : `Run ${status}.` });
}

export async function cancelCalibration(formData: FormData) {
  const { user } = await requireAdmin();
  const parsed = RunId.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go("/admin/calibration", { error: "Unknown run." });
  await cancelCalibrationRun(createAdminClient(), parsed.data!.run_id, user.id);
  goRubric(parsed.data!.rubric_key, { ok: "Run cancelled. The previous finished run's statuses still apply." });
}
