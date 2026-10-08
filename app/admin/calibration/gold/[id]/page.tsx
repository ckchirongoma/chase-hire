import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";
import { fmtDate } from "@/lib/format";
import { RubricRow } from "@/lib/grading/schema";
import { calibrationLeaves, readHumanScores, scoredByBoth } from "@/lib/calibration/criteria";
import { GOLD_COLS, type GoldSampleRow } from "@/lib/server/calibration";
import RubricBreakdown from "@/components/admin/rubric-breakdown";
import { deleteGoldSample, saveHumanScores, updateGoldSample } from "../../actions";

export const dynamic = "force-dynamic";

/**
 * One gold sample: its text, each rater's 1–5 scores per calibrated criterion (entered one rater at
 * a time, so neither sees the other's column), and the AI grades from the latest calibration run
 * (kept closed until both raters have scored, so the humans score blind).
 */
export default async function GoldSamplePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ rater?: string; ok?: string; error?: string }>;
}) {
  const { supabase } = await requireAdmin();
  const { id } = await params;
  const { rater: raterParam, ok, error } = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();
  const { data } = await supabase.from("gold_samples").select(GOLD_COLS).eq("id", id).maybeSingle<GoldSampleRow>();
  if (!data) notFound();
  const gold = data;
  const { data: rubricRow } = await supabase
    .from("rubrics")
    .select("id, key, version, title, criteria, generic_baseline")
    .eq("key", gold.rubric_key)
    .eq("active", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const rubric = rubricRow ? RubricRow.parse(rubricRow) : null;
  const leaves = rubric ? calibrationLeaves(rubric.criteria) : [];
  const keys = leaves.map((l) => l.key);
  const human = readHumanScores(gold.human_scores);
  const both = scoredByBoth(human, keys);
  const rater = raterParam === "2" ? 2 : raterParam === "1" ? 1 : null;
  const filled = (r: 1 | 2) => keys.filter((k) => human[k]?.[r - 1] != null).length;

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link href={`/admin/calibration?rubric=${gold.rubric_key}`} className="underline">
          ← Calibration: {gold.rubric_key}
        </Link>
      </p>
      <h1 className="h1">
        Gold sample: {gold.label} <span className="muted">· {gold.rubric_key}</span>
      </h1>
      {error && <p className="error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}

      <section className="card space-y-2 text-sm">
        <p className="muted">
          Added {fmtDate(gold.created_at)}
          {gold.file_path ? ` · from a file (${gold.file_path.split("/").pop()})` : ""} · {gold.text_content.length.toLocaleString("en-US")} characters
        </p>
        <details>
          <summary className="cursor-pointer underline">Read the submission</summary>
          <pre className="mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs" data-testid="gold-text">
            {gold.text_content}
          </pre>
        </details>
        <details>
          <summary className="cursor-pointer underline">Edit the label or text</summary>
          <form action={updateGoldSample} className="mt-2 space-y-2">
            <input type="hidden" name="gold_id" value={gold.id} />
            <input name="label" defaultValue={gold.label} required maxLength={120} className="input" />
            <textarea name="text" defaultValue={gold.text_content} rows={10} className="input" />
            <button className="btn-secondary">Save</button>
          </form>
        </details>
      </section>

      <section className="card space-y-3" data-testid="human-scores">
        <h2 className="h2">Human scores</h2>
        <p className="text-sm">
          Two people score every criterion 1–5 against the rubric anchors, independently: each opens their own column and doesn&apos;t look at the other&apos;s or at the
          AI&apos;s grades until both are in. {both}/{keys.length} criteria scored by both · rater 1: {filled(1)} · rater 2: {filled(2)}.
        </p>
        <div className="flex gap-2 text-sm">
          {[1, 2].map((r) => (
            <Link key={r} href={`/admin/calibration/gold/${gold.id}?rater=${r}`} className={rater === r ? "btn" : "btn-secondary"}>
              I am rater {r}
            </Link>
          ))}
        </div>
        {!rubric ? (
          <p className="error">The rubric {gold.rubric_key} has no active version.</p>
        ) : rater ? (
          <form action={saveHumanScores} className="space-y-2">
            <input type="hidden" name="gold_id" value={gold.id} />
            <input type="hidden" name="rater" value={rater} />
            <table className="table text-sm">
              <thead>
                <tr>
                  <th>Criterion and anchors</th>
                  <th>Rater {rater}</th>
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
                      <select name={`h${rater}:${l.key}`} defaultValue={human[l.key]?.[rater - 1] ?? ""} className="input w-24" aria-label={`Rater ${rater} score for ${l.key}`}>
                        <option value="">—</option>
                        {[1, 2, 3, 4, 5].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn">Save rater {rater}&apos;s scores</button>
          </form>
        ) : (
          <p className="muted">Choose your rater column to score.</p>
        )}
      </section>

      <details className="space-y-2" open={both === keys.length && keys.length > 0}>
        <summary className="cursor-pointer text-sm underline">
          AI grades from the latest calibration run{both < keys.length ? " (open only after both raters have scored)" : ""}
        </summary>
        <RubricBreakdown subjectType="gold" subjectId={gold.id} />
      </details>

      <section className="card space-y-2 text-sm">
        <h2 className="h2">Delete</h2>
        <form action={deleteGoldSample} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="gold_id" value={gold.id} />
          <input name="confirm" placeholder='type "delete"' className="input w-40" />
          <button className="btn-secondary">Delete this gold sample</button>
        </form>
        <p className="muted">Its AI grades go too. Finished runs keep their report.</p>
      </section>
    </div>
  );
}
