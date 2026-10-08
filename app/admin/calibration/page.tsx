import Link from "next/link";
import { requireAdmin } from "@/lib/server/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/config";
import { fmtDate } from "@/lib/format";
import { inChunks } from "@/lib/server/query";
import { calibrationLeaves, readHumanScores, scoredByBoth } from "@/lib/calibration/criteria";
import { MIN_GOLD, RECOMMENDED_GOLD } from "@/lib/calibration/stats";
import {
  currentRubric,
  driftReport,
  GOLD_COLS,
  promptVersionsFor,
  RUN_COLS,
  runProgress,
  syncCalibrationRuns,
  workRubricKeys,
  type CalibrationRunRow,
  type GoldSampleRow,
} from "@/lib/server/calibration";
import CalibrationReport from "@/components/admin/calibration-report";
import CalibrationDrift from "@/components/admin/calibration-drift";
import { addGoldSample, cancelCalibration, continueCalibration, finishCalibration, runCalibration } from "./actions";

export const dynamic = "force-dynamic";
// Server actions on this page grade gold samples inline for up to ~100 s.
export const maxDuration = 300;

/** What changed since a run (CLAUDE.md: rubric, prompt or model changes need a gold-set re-run). */
function changedSince(run: CalibrationRunRow, current: { version: number; model: string; prompts: string[] }): string[] {
  const out: string[] = [];
  if (run.rubric_version !== current.version) out.push(`rubric v${run.rubric_version} → v${current.version}`);
  if (run.model !== current.model) out.push(`model ${run.model} → ${current.model}`);
  if (run.prompt_versions.join(",") !== current.prompts.join(",")) out.push(`prompts ${run.prompt_versions.join(", ")} → ${current.prompts.join(", ")}`);
  return out;
}

/**
 * Grader calibration (docs/09 §8): gold set per work rubric, two independent human scores per
 * criterion, "Run graders on the gold set" with the current rubric/prompts/model, the ICC/kappa
 * report with the go-live status per criterion, and the drift check.
 */
export default async function CalibrationPage({ searchParams }: { searchParams: Promise<{ rubric?: string; ok?: string; error?: string }> }) {
  const { supabase } = await requireAdmin();
  const { rubric: requested, ok, error } = await searchParams;
  const service = createAdminClient();
  await syncCalibrationRuns(service);

  const keys = await workRubricKeys(service);
  const key = requested && keys.includes(requested) ? requested : keys[0];
  if (!key) return <p className="muted">No work rubrics yet.</p>;

  const [rubric, { data: runRows }, { data: goldRows }, drift] = await Promise.all([
    currentRubric(service, key),
    supabase.from("calibration_runs").select(RUN_COLS).eq("rubric_key", key).order("ran_at", { ascending: false }).limit(10),
    supabase.from("gold_samples").select(GOLD_COLS).eq("rubric_key", key).order("created_at"),
    driftReport(service, key),
  ]);
  const runs = (runRows ?? []) as CalibrationRunRow[];
  const gold = (goldRows ?? []) as GoldSampleRow[];
  const leaves = calibrationLeaves(rubric.criteria);
  const leafKeys = leaves.map((l) => l.key);
  const latestDone = runs.find((r) => r.status === "done") ?? null;
  const running = runs.find((r) => r.status === "running") ?? null;
  const progress = running ? await runProgress(service, running) : null;
  const current = { version: rubric.version, model: serverEnv().OPENROUTER_MODEL_GRADER, prompts: promptVersionsFor(leaves) };

  const graded = await inChunks<{ subject_id: string }>(gold.map((g) => g.id), (c) =>
    supabase.from("grade_summaries").select("subject_id").eq("subject_type", "gold").eq("rubric_id", rubric.id).in("subject_id", c),
  );
  const gradedCount = new Map<string, number>();
  for (const g of graded) gradedCount.set(g.subject_id, (gradedCount.get(g.subject_id) ?? 0) + 1);
  const fullyScored = gold.filter((g) => scoredByBoth(readHumanScores(g.human_scores), leafKeys) === leafKeys.length).length;

  return (
    <div className="space-y-4">
      <h1 className="h1">Grader calibration</h1>
      <p className="muted">
        Before going live, and after any rubric, prompt or model change: a gold set of 20–30 submissions per work rubric spanning weak to excellent, each scored
        1–5 per criterion by two people independently. Running the graders on the gold set compares the AI with the humans per criterion (ICC(2,1) absolute
        agreement and quadratic weighted kappa). Criteria with ICC ≥ .75 go live; .60–.75 go live with mandatory human review; below .60 are human-scored only.
        AI scores stay advisory either way.
      </p>
      <nav className="flex flex-wrap gap-2 text-sm">
        {keys.map((k) => (
          <Link key={k} href={`/admin/calibration?rubric=${k}`} className={k === key ? "btn" : "btn-secondary"}>
            {k}
          </Link>
        ))}
      </nav>
      {error && <p className="error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}

      <section className="card space-y-3">
        <h2 className="h2">
          {rubric.title} <span className="muted">v{rubric.version}: go-live status</span>
        </h2>
        {latestDone ? (
          <CalibrationReport run={latestDone} changed={changedSince(latestDone, current)} />
        ) : (
          <p className="muted" data-testid="no-calibration">
            No finished calibration run yet. Until there is one, grades are not flagged by calibration (every criterion is graded as today).
          </p>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="h2">Run graders on the gold set</h2>
        <p className="text-sm">
          {gold.length} gold sample{gold.length === 1 ? "" : "s"} · {fullyScored} fully scored by both humans · {leaves.length} criteria calibrated · model{" "}
          {current.model} · prompts {current.prompts.join(", ")}
        </p>
        {gold.length < RECOMMENDED_GOLD && (
          <p className="notice">
            docs/09 asks for 20–30 gold samples per rubric. A criterion needs at least {MIN_GOLD} samples scored by both humans before it can go live.
          </p>
        )}
        {running ? (
          <div className="space-y-2 text-sm" data-testid="calibration-running">
            <p>
              Run started {fmtDate(running.ran_at)}: {progress!.graded} of {progress!.total} graded{progress!.failed ? `, ${progress!.failed} failed` : ""}. The grading
              worker continues in the background; Continue grades more now.
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                { action: continueCalibration, label: "Continue", cls: "btn" },
                { action: finishCalibration, label: "Finish now with what is graded", cls: "btn-secondary" },
                { action: cancelCalibration, label: "Cancel run", cls: "btn-secondary" },
              ].map((b) => (
                <form key={b.label} action={b.action}>
                  <input type="hidden" name="run_id" value={running.id} />
                  <input type="hidden" name="rubric_key" value={key} />
                  <button className={b.cls}>{b.label}</button>
                </form>
              ))}
            </div>
          </div>
        ) : (
          <form action={runCalibration}>
            <input type="hidden" name="rubric_key" value={key} />
            <button className="btn" disabled={!gold.length}>
              Run graders on the gold set ({gold.length} samples × {leaves.length} criteria × 3 samples)
            </button>
          </form>
        )}
        {runs.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer underline">Run history ({runs.length})</summary>
            <table className="table text-sm">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Rubric</th>
                  <th>Model</th>
                  <th>Samples</th>
                  <th>Passed</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.ran_at)}</td>
                    <td>
                      {r.status}
                      {r.error ? <span className="muted"> · {r.error}</span> : null}
                    </td>
                    <td>v{r.rubric_version}</td>
                    <td>{r.model}</td>
                    <td>{r.gold_sample_ids.length}</td>
                    <td>{r.passed === null ? "—" : r.passed ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="h2">Gold set ({gold.length})</h2>
        {gold.length > 0 && (
          <table className="table text-sm" data-testid="gold-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Added</th>
                <th>Human scores (both raters)</th>
                <th>AI graded</th>
              </tr>
            </thead>
            <tbody>
              {gold.map((g) => {
                const both = scoredByBoth(readHumanScores(g.human_scores), leafKeys);
                return (
                  <tr key={g.id}>
                    <td>
                      <Link href={`/admin/calibration/gold/${g.id}`} className="underline">
                        {g.label}
                      </Link>
                      {g.file_path && <span className="muted"> · file</span>}
                    </td>
                    <td>{fmtDate(g.created_at)}</td>
                    <td>
                      {both}/{leafKeys.length} {both === leafKeys.length ? <span className="badge">complete</span> : <span className="badge-warn">to score</span>}
                    </td>
                    <td>{gradedCount.get(g.id) ? `${gradedCount.get(g.id)} criteria` : <span className="muted">not yet</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <details className="text-sm" open={gold.length === 0}>
          <summary className="cursor-pointer font-medium underline">Add a gold sample</summary>
          <form action={addGoldSample} className="mt-2 space-y-2" encType="multipart/form-data">
            <input type="hidden" name="rubric_key" value={key} />
            <label className="label">
              Label
              <input name="label" required maxLength={120} className="input" placeholder="e.g. weak: no gap log; strong; doc 13 reference" />
            </label>
            <label className="label">
              Submission text (paste)
              <textarea name="text" rows={6} className="input" placeholder="Paste the memo, handoff, README + release notes, or Loom transcript as the candidate would submit it" />
            </label>
            <label className="label">
              Or upload a file (.txt, .md, .docx, .pdf; max 10 MB)
              <input name="file" type="file" accept=".txt,.md,.docx,.pdf" className="input" />
            </label>
            <button className="btn">Add gold sample</button>
          </form>
        </details>
      </section>

      <CalibrationDrift report={drift} />
    </div>
  );
}
