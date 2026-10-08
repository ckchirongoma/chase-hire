import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { fmtDate } from "@/lib/format";
import { calibrationLeaves } from "@/lib/calibration/criteria";
import { currentRubric, isDriftPick } from "@/lib/server/calibration";
import { saveDriftRescores } from "../../actions";

export const dynamic = "force-dynamic";

/**
 * Drift re-score of one picked submission (docs/09 §8.4). The admin reads the submission and scores
 * every calibrated criterion 1–5 against the anchors, blind: the AI's medians appear only after
 * they have re-scored every criterion. Re-scores live in drift_rescores and never change the
 * candidate's score (to override a grade, use the review queue on the candidate page).
 */
export default async function DriftRescorePage({
  params,
  searchParams,
}: {
  params: Promise<{ submissionId: string }>;
  searchParams: Promise<{ rubric?: string; ok?: string; error?: string }>;
}) {
  const { supabase, user } = await requireAdmin();
  const { submissionId } = await params;
  const { rubric: rubricKey, ok, error } = await searchParams;
  if (!z.uuid().safeParse(submissionId).success || !rubricKey || !/^[a-z0-9_]{1,40}$/.test(rubricKey)) notFound();
  const service = createAdminClient();
  if (!(await isDriftPick(service, rubricKey, submissionId))) notFound();

  const [{ data: sub }, rubric, { data: mine }] = await Promise.all([
    supabase
      .from("submissions")
      .select("id, user_id, stage_key, created_at, sanitised_text, loom_transcript, repo_url, deployed_url, mvp_url, loom_url")
      .eq("id", submissionId)
      .maybeSingle(),
    currentRubric(service, rubricKey),
    supabase.from("drift_rescores").select("criterion_key, score").eq("submission_id", submissionId).eq("rater", user.id),
  ]);
  if (!sub) notFound();
  const leaves = calibrationLeaves(rubric.criteria);
  const my = new Map((mine ?? []).map((r) => [r.criterion_key as string, Number(r.score)]));
  const done = leaves.length > 0 && leaves.every((l) => my.has(l.key));
  const { data: ai } = done
    ? await supabase.from("grade_summaries").select("criterion_key, median_score").eq("subject_type", "submission").eq("subject_id", submissionId)
    : { data: [] as { criterion_key: string; median_score: number | null }[] };
  const aiBy = new Map((ai ?? []).map((r) => [r.criterion_key as string, r.median_score === null ? null : Number(r.median_score)]));
  const links = [
    ["Repository", sub.repo_url],
    ["Deployed app", sub.deployed_url],
    ["MVP", sub.mvp_url],
    ["Loom", sub.loom_url],
  ].filter((x): x is [string, string] => typeof x[1] === "string" && x[1].length > 0);

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link href={`/admin/calibration?rubric=${rubricKey}`} className="underline">
          ← Calibration: {rubricKey}
        </Link>
      </p>
      <h1 className="h1">
        Drift re-score <span className="muted">· {sub.stage_key} · submitted {fmtDate(sub.created_at)}</span>
      </h1>
      {error && <p className="error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
      <p className="muted text-sm">
        Score the submission yourself against the anchors. The AI&apos;s scores appear once you have scored every criterion. Your re-scores never change the
        candidate&apos;s score; to override a grade, use the review queue on the{" "}
        <Link href={`/admin/candidates/${sub.user_id}`} className="underline">
          candidate page
        </Link>
        .
      </p>

      <section className="card space-y-2 text-sm">
        {links.length > 0 && (
          <p>
            {links.map(([label, url]) => (
              <a key={label} href={url} target="_blank" rel="noreferrer" className="mr-3 underline">
                {label}
              </a>
            ))}
          </p>
        )}
        <details open>
          <summary className="cursor-pointer underline">Read the submission</summary>
          <pre className="mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs" data-testid="drift-text">
            {sub.sanitised_text || "(No extracted text: open the links above.)"}
          </pre>
        </details>
        {sub.loom_transcript && (
          <details>
            <summary className="cursor-pointer underline">Loom transcript</summary>
            <pre className="mt-2 max-h-[24rem] overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs">{sub.loom_transcript}</pre>
          </details>
        )}
      </section>

      <form action={saveDriftRescores} className="card space-y-2" data-testid="drift-form">
        <input type="hidden" name="submission_id" value={sub.id} />
        <input type="hidden" name="rubric_key" value={rubricKey} />
        <table className="table text-sm">
          <thead>
            <tr>
              <th>Criterion and anchors</th>
              <th>Your score</th>
              {done && <th>AI median</th>}
            </tr>
          </thead>
          <tbody>
            {leaves.map((l) => (
              <tr key={l.key}>
                <td>
                  <p className="font-medium">{l.parentTitle ? `${l.parentTitle} › ${l.title}` : l.title}</p>
                  <details className="text-xs">
                    <summary className="cursor-pointer text-slate-600">anchors</summary>
                    {(["1", "3", "5"] as const).map((a) => (
                      <p key={a}>
                        <strong>{a}</strong>: {l.criterion.anchors[a] ?? "—"}
                      </p>
                    ))}
                  </details>
                </td>
                <td>
                  <select name={`d:${l.key}`} defaultValue={my.get(l.key) ?? ""} className="input w-24" aria-label={`Your score for ${l.key}`}>
                    <option value="">—</option>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </td>
                {done && <td>{aiBy.get(l.key) ?? "—"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn">Save my re-scores</button>
      </form>
    </div>
  );
}
