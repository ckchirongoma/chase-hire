import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Server actions run as whichever client h.client holds.
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));

import { addGoldSample, cancelCalibration, deleteGoldSample, runCalibration, saveDriftRescores, saveHumanScores, updateGoldSample } from "@/app/admin/calibration/actions";
import { applyRunStatuses, driftReport, finishRunIfComplete, freezeDriftBlocks, loadRun, processCalibrationRun, startCalibrationRun } from "@/lib/server/calibration";
import { enqueueGrading, findGradingJob, gradeCriterion, runGradingJob } from "@/lib/server/grading";
import { latestCalibration } from "@/lib/calibration/status";
import { calibrationLeaves } from "@/lib/calibration/criteria";
import { criterionBlock, RubricRow, type RubricCriterion } from "@/lib/grading";
import { BA_PART2 } from "@/lib/grading/rubrics/ba-part2";
import { loadPrompt } from "@/lib/prompts";
import { wrapUntrusted } from "@/lib/sanitise";
import { consent, fakeFinishedAttempt, fakeParsedCv, makeAdmin, newUser, psql, service } from "../helpers/local";

/**
 * Calibration runs against ISOLATED test rubrics (copies of BA Part 2 under unique keys), so the
 * statuses they produce never touch the real rubrics other tests grade with.
 */

const admin = service();
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const KEY = `cal_test_${suffix}`;
const FRESH = `cal_fresh_${suffix}`; // a rubric with no calibration run
const SMALL = `cal_small_${suffix}`;
const CANCEL = `cal_cancel_${suffix}`;
let boss: Awaited<ReturnType<typeof newUser>>;
let boss2: Awaited<ReturnType<typeof newUser>>;
const fakeSubmissions: string[] = [];
let rubric: RubricRow;
let fresh: RubricRow;
const goldIds: string[] = [];

async function insertRubric(key: string): Promise<RubricRow> {
  const { data, error } = await admin
    .from("rubrics")
    .insert({ key, version: 1, title: `Calibration test (${key})`, criteria: BA_PART2.criteria, reference: BA_PART2.reference, active: true })
    .select("id, key, version, title, criteria, generic_baseline")
    .single();
  if (error) throw error;
  return RubricRow.parse(data);
}

beforeAll(async () => {
  boss = await newUser("calibration-admin");
  await makeAdmin(boss.id);
  boss2 = await newUser("calibration-admin-2");
  await makeAdmin(boss2.id);
  rubric = await insertRubric(KEY);
  fresh = await insertRubric(FRESH);
  await insertRubric(SMALL);
  await insertRubric(CANCEL);
});

afterAll(async () => {
  const keys = [KEY, FRESH, SMALL, CANCEL];
  await admin.from("drift_blocks").delete().in("rubric_key", keys);
  if (fakeSubmissions.length) await admin.from("submissions").delete().in("id", fakeSubmissions);
  const { data: gold } = await admin.from("gold_samples").select("id").in("rubric_key", keys);
  const ids = [...new Set([...goldIds, ...(gold ?? []).map((g) => g.id as string)])];
  if (ids.length) {
    await admin.from("grading_jobs").delete().eq("subject_type", "gold").in("subject_id", ids);
    await admin.from("gold_samples").delete().in("id", ids);
  }
  const { data: rubrics } = await admin.from("rubrics").select("id").in("key", keys);
  const rubricIds = (rubrics ?? []).map((r) => r.id as string);
  if (rubricIds.length) {
    await admin.from("grades").delete().in("rubric_id", rubricIds);
    await admin.from("grade_summaries").delete().in("rubric_id", rubricIds);
  }
  await admin.from("calibration_runs").delete().in("rubric_key", keys);
  await admin.from("rubrics").delete().in("key", keys);
});

const form = (fields: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
/** Runs a server action and returns where it sent the browser ("404" for notFound). */
async function outcome(action: Promise<unknown>): Promise<URL | "404"> {
  try {
    await action;
  } catch (err) {
    const digest = String((err as { digest?: unknown }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT;")) return new URL(digest.split(";").slice(2, -2).join(";"), "http://localhost");
    if (digest === "NEXT_HTTP_ERROR_FALLBACK;404") return "404";
    throw err;
  }
  throw new Error("the action returned without redirecting");
}
const msg = (r: URL | "404", key: "error" | "ok") => (r === "404" ? "404" : r.searchParams.get(key));

const MEMO = [
  "Handoff pack for the Kopano renewal desk, written for the engineering team.",
  "The data model keeps customers, accounts and lines at the right grain with stable keys.",
  "Out of scope: bulk messaging, a management dashboard and dialler integration.",
].join("\n");

describe("gold samples (CRUD)", () => {
  it("adds by paste or upload, edits, takes two independent human scores, and deletes", async () => {
    h.client = boss.client;
    // Paste.
    const added = await outcome(addGoldSample(form({ rubric_key: KEY, label: "strong", text: MEMO })));
    expect(added !== "404" && added.pathname).toMatch(/^\/admin\/calibration\/gold\/[0-9a-f-]{36}$/);
    const id = (added as URL).pathname.split("/").pop()!;
    goldIds.push(id);
    const { data: row } = await admin.from("gold_samples").select("rubric_key, label, text_content, created_by, human_scores, file_path").eq("id", id).single();
    expect(row).toMatchObject({ rubric_key: KEY, label: "strong", text_content: MEMO, created_by: boss.id, human_scores: {}, file_path: null });

    // Upload a Markdown file: text extracted, file kept in the private gold bucket.
    const file = new File([`# Weak handoff\n\n${MEMO}`], "weak.md", { type: "text/markdown" });
    const up = await outcome(addGoldSample(form({ rubric_key: KEY, label: "weak (file)", file })));
    const upId = (up as URL).pathname.split("/").pop()!;
    goldIds.push(upId);
    const { data: upRow } = await admin.from("gold_samples").select("text_content, file_path").eq("id", upId).single();
    expect(upRow!.text_content).toContain("# Weak handoff");
    expect(upRow!.file_path).toMatch(new RegExp(`^${KEY}/[0-9a-f-]{36}\\.md$`));
    const { data: stored } = await admin.storage.from("gold").download(upRow!.file_path!);
    expect(await stored!.text()).toContain("Weak handoff");

    // Validation.
    expect(msg(await outcome(addGoldSample(form({ rubric_key: KEY, label: "short", text: "too short" }))), "error")).toMatch(/at least 50 characters/);
    expect(msg(await outcome(addGoldSample(form({ rubric_key: KEY, label: "img", file: new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "x.png") }))), "error")).toMatch(/\.txt, \.md, \.docx or \.pdf/);
    expect(msg(await outcome(addGoldSample(form({ rubric_key: "no_such_rubric", label: "label", text: MEMO }))), "error")).toMatch(/Unknown rubric/);

    // Edit.
    expect(msg(await outcome(updateGoldSample(form({ gold_id: id, label: "strong (edited)", text: `${MEMO}\nAppendix A.` }))), "ok")).toMatch(/Saved/);
    const { data: edited } = await admin.from("gold_samples").select("label, text_content").eq("id", id).single();
    expect(edited).toMatchObject({ label: "strong (edited)", text_content: `${MEMO}\nAppendix A.` });

    // Two different people, one column each (docs/09 §8.1). The first save claims the column.
    expect(msg(await outcome(saveHumanScores(form({ gold_id: id, rater: "1", "h1:data_model": "4", "h1:mvp": "9" }))), "error")).toMatch(/1 to 5 \(mvp\)/);
    expect(msg(await outcome(saveHumanScores(form({ gold_id: id, rater: "1", "h1:data_model": "4", "h1:handoff": "2", "h2:data_model": "1" }))), "ok")).toMatch(/Rater 1/);
    // The same person can't also fill the second column.
    expect(msg(await outcome(saveHumanScores(form({ gold_id: id, rater: "2", "h2:data_model": "1" }))), "error")).toMatch(/already score the other column/);
    h.client = boss2.client;
    // Column 1 belongs to the first admin: refused, their score is kept.
    expect(msg(await outcome(saveHumanScores(form({ gold_id: id, rater: "1", "h1:data_model": "1" }))), "error")).toMatch(/Another admin is scoring that column/);
    expect(msg(await outcome(saveHumanScores(form({ gold_id: id, rater: "2", "h2:data_model": "5", "h2:judgement": "3" }))), "ok")).toMatch(/Rater 2/);
    const { data: scored } = await admin.from("gold_samples").select("human_scores, human_raters").eq("id", id).single();
    // Rater 1's form can't write rater 2's column; rater 2's save keeps rater 1's scores.
    expect(scored!.human_scores).toEqual({ data_model: [4, 5], handoff: [2, null], judgement: [null, 3] });
    expect(scored!.human_raters).toEqual({ "1": boss.id, "2": boss2.id });
    // Saves at the same moment don't overwrite each other (one SQL write per column, under a row lock).
    const [a, b] = await Promise.all([
      boss.client.rpc("save_gold_human_scores", { p_gold_id: id, p_rater: 1, p_scores: { mvp: 3 } }),
      boss2.client.rpc("save_gold_human_scores", { p_gold_id: id, p_rater: 2, p_scores: { mvp: 4 } }),
    ]);
    expect([a.error, b.error]).toEqual([null, null]);
    // Human scores can't be written around the function.
    const direct = await boss.client.from("gold_samples").update({ human_scores: {}, human_raters: {} }).eq("id", id);
    expect(direct.error?.message).toMatch(/permission denied/);
    // Blank clears a score, in your own column only.
    h.client = boss.client;
    await outcome(saveHumanScores(form({ gold_id: id, rater: "1", "h1:data_model": "4" })));
    const { data: cleared } = await admin.from("gold_samples").select("human_scores").eq("id", id).single();
    expect(cleared!.human_scores).toEqual({ data_model: [4, 5], judgement: [null, 3], mvp: [null, 4] });

    // Delete (needs the typed confirmation); its grades go too.
    await admin.from("grade_summaries").insert({ subject_type: "gold", subject_id: upId, rubric_id: rubric.id, criterion_key: "mvp", weight: 1, median_score: 3, final_score: 3 });
    expect(msg(await outcome(deleteGoldSample(form({ gold_id: upId, confirm: "no" }))), "error")).toMatch(/delete/);
    expect(msg(await outcome(deleteGoldSample(form({ gold_id: upId, confirm: "delete" }))), "ok")).toMatch(/deleted/);
    expect((await admin.from("gold_samples").select("id").eq("id", upId)).data).toEqual([]);
    expect((await admin.from("grade_summaries").select("id").eq("subject_type", "gold").eq("subject_id", upId)).data).toEqual([]);
    const { data: gone } = await admin.storage.from("gold").download(upRow!.file_path!);
    expect(gone).toBeNull();
    await admin.from("gold_samples").delete().eq("id", id);
  });

  it("non-admins are refused, and RLS hides the gold set", async () => {
    const cand = await newUser("calibration-cand");
    h.client = cand.client;
    expect(await outcome(addGoldSample(form({ rubric_key: KEY, label: "x", text: MEMO })))).toBe("404");
    expect(await outcome(runCalibration(form({ rubric_key: KEY })))).toBe("404");
    expect(await outcome(saveHumanScores(form({ gold_id: randomUUID(), rater: "1" })))).toBe("404");
    expect((await cand.client.from("gold_samples").select("id")).data).toEqual([]);
    expect((await cand.client.from("calibration_runs").select("id")).data).toEqual([]);
    const { error } = await cand.client.from("gold_samples").insert({ rubric_key: KEY, label: "x", text_content: MEMO });
    expect(error).not.toBeNull();
  });
});

// Ten gold samples spanning weak to excellent. Both humans give HUMAN[i] on every criterion.
// The stub judge scores what the STUB:SCORE markers say: data_model agrees exactly, mvp agrees
// moderately, handoff is reversed; the other criteria get the stub's default 3.
const HUMAN = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5];
const MVP_AI = [3, 1, 2, 5, 4, 2, 3, 2, 4, 5];

async function seedGoldSet(key: string, n = 10) {
  const leaves = calibrationLeaves(BA_PART2.criteria).map((l) => l.key);
  const rows = Array.from({ length: n }, (_, i) => ({
    rubric_key: key,
    label: `sample ${i + 1} (human ${HUMAN[i]})`,
    created_by: boss.id,
    text_content: [
      `Handoff pack sample ${i + 1} for the Kopano renewal desk team.`,
      "The data model covers customers, accounts and lines with stable keys.",
      `STUB:SCORE:data_model=${HUMAN[i]} STUB:SCORE:mvp=${MVP_AI[i]} STUB:SCORE:handoff=${6 - HUMAN[i]}`,
    ].join("\n"),
    human_scores: Object.fromEntries(leaves.map((k) => [k, [HUMAN[i], HUMAN[i]]])),
  }));
  const { data, error } = await admin.from("gold_samples").insert(rows).select("id");
  if (error) throw error;
  goldIds.push(...data.map((d) => d.id as string));
  return data.map((d) => d.id as string);
}

/**
 * A real BA Part 2 submission (an application in play) whose grades were stored on rubric `r`
 * before any calibration: every top-level criterion scored 4 by the AI.
 */
async function storedSubmission(r: RubricRow) {
  const u = await newUser("calibration-cand-graded");
  await consent(u.client);
  await fakeParsedCv(u.id);
  await fakeFinishedAttempt(u.id, 4);
  const { data: appId, error } = await u.client.rpc("apply_to_role", { p_slug: "business-analyst" });
  if (error) throw error;
  const { data: stage } = await admin.from("work_stages").select("id, key").eq("role_slug", "business-analyst").eq("app_stage", "work_2").single();
  const [attempt, sub] = [randomUUID(), randomUUID()];
  psql(`set session_replication_role = replica;
    insert into public.work_attempts (id, application_id, stage_id, user_id, open_until, started_at, submitted_at)
      values ('${attempt}', '${appId}', '${stage!.id}', '${u.id}', now(), now() - interval '1 day', now() - interval '1 hour');
    insert into public.submissions (id, attempt_id, user_id, stage_key, score, grading_status)
      values ('${sub}', '${attempt}', '${u.id}', '${stage!.key}', 75, 'done');
    update public.applications set stage = 'work_2', status = 'awaiting_review' where id = '${appId}';`);
  const rows = r.criteria.map((c) => ({ subject_type: "submission", subject_id: sub, rubric_id: r.id, criterion_key: c.key, weight: c.weight, median_score: 4, final_score: 4 }));
  const { error: gErr } = await admin.from("grade_summaries").insert(rows);
  if (gErr) throw gErr;
  return { subId: sub, appId: appId as string };
}

const summaryOf = async (subId: string, key: string) =>
  (await admin.from("grade_summaries").select("median_score, final_score, ai_final, needs_human_review, review_reason").eq("subject_type", "submission").eq("subject_id", subId).eq("criterion_key", key).single()).data!;

describe("calibration run (docs/09 §8)", () => {
  it("grades the gold set through the normal grader and reports ICC / QWK / status per criterion", { timeout: 180_000 }, async () => {
    await admin.from("gold_samples").delete().eq("rubric_key", KEY); // only this test's set
    const ids = await seedGoldSet(KEY);
    const stored = await storedSubmission(rubric); // graded before calibration: nothing flagged yet
    expect(await summaryOf(stored.subId, "handoff")).toMatchObject({ ai_final: true, needs_human_review: false });
    h.client = boss.client;
    const r = await outcome(runCalibration(form({ rubric_key: KEY })));
    expect(msg(r, "ok")).toMatch(/Calibration finished: 10 of 10 gold samples graded/);

    const { data: runs } = await admin.from("calibration_runs").select("*").eq("rubric_key", KEY);
    expect(runs).toHaveLength(1);
    const run = runs![0];
    expect(run).toMatchObject({ status: "done", rubric_version: 1, rubric_id: rubric.id, model: "stub/grader", prompt_versions: ["grader-criterion.v1"], ran_by: boss.id, passed: false });
    expect([...run.gold_sample_ids].sort()).toEqual([...ids].sort());
    expect(run.finished_at).not.toBeNull();

    const leaves = calibrationLeaves(BA_PART2.criteria).map((l) => l.key);
    expect(Object.keys(run.per_criterion).sort()).toEqual([...leaves].sort());
    for (const k of leaves) expect(run.per_criterion[k].n).toBe(10);
    expect(run.per_criterion.data_model).toMatchObject({ icc: 1, qwk: 1, human_icc: 1, n: 10, status: "live" });
    expect(run.per_criterion.mvp).toMatchObject({ icc: 0.724, status: "review" });
    expect(run.per_criterion.handoff.icc).toBeLessThan(0);
    expect(run.per_criterion.handoff.status).toBe("human_only");

    // Every gold grade went through the normal grader: 3 samples per criterion, model and prompt version stored.
    const { data: grades } = await admin.from("grades").select("criterion_key, sample_idx, model, prompt_version, temperature, rubric_id").eq("subject_type", "gold").eq("subject_id", ids[0]);
    expect(grades).toHaveLength(leaves.length * 3);
    expect(grades!.every((g) => g.model === "stub/grader" && g.prompt_version === "grader-criterion.v1" && Number(g.temperature) === 0.3 && g.rubric_id === rubric.id)).toBe(true);
    const { data: sum } = await admin.from("grade_summaries").select("final_score").eq("subject_type", "gold").eq("subject_id", ids[3]).eq("criterion_key", "mvp").single();
    expect(Number(sum!.final_score)).toBe(MVP_AI[3]);

    const latest = await latestCalibration(admin, KEY);
    expect(latest?.perCriterion.mvp).toMatchObject({ status: "review", icc: 0.724, n: 10 });

    // Finishing the run applied its statuses to the grades already stored (docs/09 §8.3).
    const handoff = await summaryOf(stored.subId, "handoff");
    expect(handoff).toMatchObject({ ai_final: false, final_score: null, needs_human_review: true });
    expect(Number(handoff.median_score)).toBe(4); // the AI's score is kept as evidence
    expect(handoff.review_reason).toMatch(/calibration: human_only/);
    const mvp = await summaryOf(stored.subId, "mvp");
    expect(mvp).toMatchObject({ ai_final: true, needs_human_review: true, review_reason: "calibration: review" });
    expect(Number(mvp.final_score)).toBe(4);
    expect(await summaryOf(stored.subId, "data_model")).toMatchObject({ ai_final: true, needs_human_review: false, review_reason: null });
    // A human-only criterion has no final score yet, so the stage score waits for a person.
    const { data: before } = await admin.from("submissions").select("score, grading_status").eq("id", stored.subId).single();
    expect(before).toMatchObject({ score: null, grading_status: "needs_review" });
    // Applying the same run again changes nothing.
    expect(await applyRunStatuses(admin, run.id)).toEqual([]);

    // A person scores the human-only criteria: the stage score comes back.
    const humanOnly = Object.entries(run.per_criterion as Record<string, { status: string }>)
      .filter(([k, v]) => v.status === "human_only" && !k.includes("."))
      .map(([k]) => k);
    expect(humanOnly).toContain("handoff");
    for (const k of humanOnly) {
      const { error } = await admin
        .from("grade_summaries")
        .update({ human_score: 4, human_reason: "Read the submission against the anchors: solid.", human_by: boss.id, human_at: new Date().toISOString() })
        .eq("subject_type", "submission")
        .eq("subject_id", stored.subId)
        .eq("criterion_key", k);
      expect(error).toBeNull();
    }
    expect(Number((await summaryOf(stored.subId, "handoff")).final_score)).toBe(4);
    const { data: after } = await admin.from("submissions").select("score").eq("id", stored.subId).single();
    expect(Number(after!.score)).toBe(75);
  });

  it("applies the statuses in grading: review / human_only flag the criterion; live and uncalibrated rubrics don't", async () => {
    const grader = loadPrompt("grader-criterion", 1);
    const gradeOne = async (r: RubricRow, key: string, subjectType: "submission" | "gold" = "submission", model = "stub/grader") => {
      const c = r.criteria.find((x) => x.key === key) as RubricCriterion;
      const body = `[HANDOFF PACK]\nThe data model keeps customers and accounts at the right grain.\nThe MVP shows the renewal queue for the next ninety days.\nSTUB:SCORE:${key}=4`;
      const subjectId = randomUUID();
      const res = await gradeCriterion(admin, {
        subjectType,
        subjectId,
        rubricId: r.id,
        criterion: c,
        system: grader.system,
        userContent: [criterionBlock(c), `SUBMISSION:\n${wrapUntrusted("submission", body)}`].join("\n\n"),
        subjectText: body,
        promptVersion: grader.promptVersion,
        model,
      });
      const { data } = await admin.from("grade_summaries").select("needs_human_review, review_reason, median_score, final_score, ai_final").eq("subject_type", subjectType).eq("subject_id", subjectId).single();
      expect(res.needsHumanReview).toBe(data!.needs_human_review);
      return { res, summary: data! };
    };

    const review = await gradeOne(rubric, "mvp");
    expect(review.summary).toMatchObject({ needs_human_review: true });
    expect(review.summary.review_reason).toBe("calibration: review");
    expect(Number(review.summary.median_score)).toBe(4); // the AI score is kept; a person must confirm it

    const humanOnly = await gradeOne(rubric, "handoff");
    expect(humanOnly.summary).toMatchObject({ needs_human_review: true, review_reason: "calibration: human_only", ai_final: false, final_score: null });
    expect(Number(humanOnly.summary.median_score)).toBe(4); // evidence only
    expect(humanOnly.res.finalScore).toBeNull(); // what the stage score aggregates

    const live = await gradeOne(rubric, "data_model");
    expect(live.summary).toMatchObject({ needs_human_review: false, review_reason: null });

    // The grader changed since the run (another model): stale, nothing is treated as live.
    const stale = await gradeOne(rubric, "data_model", "submission", "other/model");
    expect(stale.summary).toMatchObject({ needs_human_review: true, ai_final: true });
    expect(stale.summary.review_reason).toMatch(/^calibration: stale, re-run the gold set \(model stub\/grader → other\/model\)/);
    const staleHuman = await gradeOne(rubric, "handoff", "submission", "other/model");
    expect(staleHuman.summary).toMatchObject({ ai_final: false, final_score: null });

    // No finished run for a rubric → today's behaviour.
    const uncalibrated = await gradeOne(fresh, "mvp");
    expect(uncalibrated.summary).toMatchObject({ needs_human_review: false, review_reason: null });

    // Gold samples themselves are never flagged by calibration.
    const gold = await gradeOne(rubric, "mvp", "gold");
    expect(gold.summary).toMatchObject({ needs_human_review: false, review_reason: null });
  });

  it("finishes a run from the grading worker when the last gold sample is graded; guards concurrent runs", { timeout: 120_000 }, async () => {
    await expect(startCalibrationRun(admin, SMALL, boss.id)).rejects.toThrow(/Add gold samples/);
    const ids = await seedGoldSet(SMALL, 2);
    const run = await startCalibrationRun(admin, SMALL, boss.id);
    await expect(startCalibrationRun(admin, SMALL, boss.id)).rejects.toThrow(/still in progress/);

    // No time budget: nothing graded inline, the run stays open.
    const first = await processCalibrationRun(admin, run.id, 0);
    expect(first.run.status).toBe("running");
    expect(first.progress).toMatchObject({ total: 2, graded: 0, pending: 2 });

    // The worker grades the samples; the handler closes the run after the last one.
    for (const id of ids) {
      const job = await findGradingJob(admin, "gold", id);
      expect(job?.status).toBe("queued");
      expect(await runGradingJob(admin, job!.id as string)).toMatchObject({ status: "done" });
    }
    const done = await loadRun(admin, run.id);
    expect(done).toMatchObject({ status: "done", passed: false });
    // Two samples are far below the minimum: every criterion stays human-only.
    expect(Object.values(done!.per_criterion).every((c) => c.status === "human_only" && c.n === 2)).toBe(true);
    expect(await finishRunIfComplete(admin, run.id, { force: true })).toMatchObject({ status: "done" }); // idempotent

    // A deleted sample's leftover job is a no-op, not a failure.
    const ghost = randomUUID();
    const jobId = await enqueueGrading(admin, "gold", ghost);
    expect(await runGradingJob(admin, jobId)).toMatchObject({ status: "done" });
    await admin.from("grading_jobs").delete().eq("id", jobId);
  });

  it("cancelling (or force-finishing) a run drops its gold jobs that haven't started", { timeout: 60_000 }, async () => {
    const ids = await seedGoldSet(CANCEL, 3);
    const run = await startCalibrationRun(admin, CANCEL, boss.id);
    const queued = async () => (await admin.from("grading_jobs").select("id").eq("subject_type", "gold").in("subject_id", ids)).data ?? [];
    expect(await queued()).toHaveLength(3);
    h.client = boss.client;
    expect(msg(await outcome(cancelCalibration(form({ run_id: run.id, rubric_key: CANCEL }))), "ok")).toMatch(/cancelled/);
    expect(await loadRun(admin, run.id)).toMatchObject({ status: "failed" });
    expect(await queued()).toEqual([]);

    const second = await startCalibrationRun(admin, CANCEL, boss.id);
    expect(await queued()).toHaveLength(3);
    expect(await finishRunIfComplete(admin, second.id, { force: true })).toMatchObject({ status: "failed" }); // nothing graded
    expect(await queued()).toEqual([]);
  });

  it("drift check: frozen blocks of 25 with 3 stable picks; re-scores never change the candidate's score", async () => {
    expect(await driftReport(admin, KEY)).toEqual({ rubricKey: KEY, graded: 0, waiting: 0, blocks: [] });

    // 26 graded submissions (test rows, invisible to the real rubrics' drift lists).
    const subs: string[] = Array.from({ length: 26 }, () => randomUUID());
    fakeSubmissions.push(...subs);
    psql(`set session_replication_role = replica;
      insert into public.submissions (id, attempt_id, user_id, stage_key, score, grading_status, created_at)
      select id, gen_random_uuid(), gen_random_uuid(), 'ba_part2', 60, 'running', now() - (n || ' minutes')::interval
      from unnest(array['${subs.join("','")}']::uuid[]) with ordinality as t(id, n);`);
    const blocks = await freezeDriftBlocks(admin, KEY, subs.map((id) => ({ id })));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ block: 1, submission_ids: subs.slice(0, 25) });
    expect(blocks[0].pick_ids).toHaveLength(3);
    expect(blocks[0].pick_ids.every((id) => subs.slice(0, 25).includes(id))).toBe(true);
    // Frozen: a re-grade or purge drops one, a late grade arrives first: the block and picks stay.
    const again = await freezeDriftBlocks(admin, KEY, [{ id: randomUUID() }, ...subs.slice(1).reverse().map((id) => ({ id }))]);
    expect(again).toEqual(blocks);

    // A person re-scores a pick: kept in drift_rescores, the candidate's grade is untouched.
    const pick = blocks[0].pick_ids[0];
    await admin.from("grade_summaries").insert({ subject_type: "submission", subject_id: pick, rubric_id: rubric.id, criterion_key: "data_model", weight: 25, median_score: 4, final_score: 4 });
    h.client = boss.client;
    expect(msg(await outcome(saveDriftRescores(form({ submission_id: pick, rubric_key: KEY, "d:data_model": "2", "d:mvp": "" }))), "ok")).toMatch(/Drift re-scores saved \(1 of/);
    const { data: rescores } = await admin.from("drift_rescores").select("criterion_key, score, rater").eq("submission_id", pick);
    expect(rescores).toEqual([{ criterion_key: "data_model", score: 2, rater: boss.id }]);
    expect(await summaryOf(pick, "data_model")).toMatchObject({ needs_human_review: false });
    expect(Number((await summaryOf(pick, "data_model")).final_score)).toBe(4);
    const { data: grade } = await admin.from("grade_summaries").select("human_score").eq("subject_id", pick).eq("criterion_key", "data_model").single();
    expect(grade!.human_score).toBeNull();

    const report = await driftReport(admin, KEY, boss.id);
    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0].agreement).toEqual({ n: 1, within1: 0, mad: 2 });
    expect(report.blocks[0].picks.find((p) => p.submissionId === pick)).toMatchObject({ rescoredByMe: 1, rescored: 1 });

    // Only picks are re-scored for drift; blank removes your re-score.
    const notPick = subs.find((id) => !blocks[0].pick_ids.includes(id))!;
    expect(msg(await outcome(saveDriftRescores(form({ submission_id: notPick, rubric_key: KEY, "d:data_model": "2" }))), "error")).toMatch(/not a drift pick/);
    await outcome(saveDriftRescores(form({ submission_id: pick, rubric_key: KEY, "d:data_model": "" })));
    expect((await admin.from("drift_rescores").select("id").eq("submission_id", pick)).data).toEqual([]);

    // The real rubrics: complete blocks are frozen with 3 picks each.
    const real = await driftReport(admin, "ba_part2");
    for (const b of real.blocks) expect(b.picks).toHaveLength(3);
    expect(real.waiting).toBeLessThan(25);
  });
});
