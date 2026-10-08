import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";
import { fmtDate } from "@/lib/format";
import { RubricRow } from "@/lib/grading/schema";
import { calibrationLeaves, readHumanScores, scoredByBoth } from "@/lib/calibration/criteria";
import { GOLD_COLS, type GoldSampleRow } from "@/lib/server/calibration";
import { raterNames } from "@/lib/server/live";
import { createAdminClient } from "@/lib/supabase/admin";
import RubricBreakdown from "@/components/admin/rubric-breakdown";
import { deleteGoldSample, saveHumanScores, updateGoldSample } from "../../actions";

export const dynamic = "force-dynamic";

/**
 * One gold sample: its text, and two different people's 1–5 scores per calibrated criterion
 * (docs/09 §8.1). Each admin sees and edits only their own column (claimed on their first save);
 * the other column and the AI grades from the latest calibration run are not rendered until both
 * columns are complete, so the humans score blind.
 */
export default async function GoldSamplePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ rater?: string; ok?: string; error?: string }>;
}) {
  const { supabase, user } = await requireAdmin();
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
  const filled = (r: 1 | 2) => keys.filter((k) => human[k]?.[r - 1] != null).length;
  const complete = keys.length > 0 && both === keys.length;
  // Who owns each column (save_gold_human_scores claims it on the first save).
  const rawOwners = (gold.human_raters ?? {}) as Record<string, unknown>;
  const owners: Record<1 | 2, string | null> = {
    1: typeof rawOwners["1"] === "string" ? rawOwners["1"] : null,
    2: typeof rawOwners["2"] === "string" ? rawOwners["2"] : null,
  };
  const mine = owners[1] === user.id ? 1 : owners[2] === user.id ? 2 : null;
  const free = mine ? [] : ([1, 2] as const).filter((r) => !owners[r]);
  const requested = raterParam === "2" ? 2 : raterParam === "1" ? 1 : null;
  // Your own column; or the free column you chose to claim.
  const column: 1 | 2 | null = mine ?? (requested && free.includes(requested) ? requested : null);
  const names = await raterNames(createAdminClient(), [owners[1], owners[2]].filter((x): x is string => Boolean(x)));

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
          Two different people score every criterion 1–5 against the rubric anchors, independently. Your first save claims a column for you; nobody sees the other
          column or the AI&apos;s grades until both columns are complete. {both}/{keys.length} criteria scored by both.
        </p>
        <ul className="text-sm" data-testid="rater-columns">
          {([1, 2] as const).map((r) => (
            <li key={r}>
              Rater {r}: {owners[r] ? (owners[r] === user.id ? "you" : names.get(owners[r]!)) : <span className="muted">free</span>} · {filled(r)}/{keys.length} scored
            </li>
          ))}
        </ul>
        {!rubric ? (
          <p className="error">The rubric {gold.rubric_key} has no active version.</p>
        ) : complete ? (
          <table className="table text-sm" data-testid="human-scores-complete">
            <thead>
              <tr>
                <th>Criterion</th>
                <th>Rater 1</th>
                <th>Rater 2</th>
              </tr>
            </thead>
            <tbody>
              {leaves.map((l) => (
                <tr key={l.key}>
                  <td>{l.parentTitle ? `${l.parentTitle} › ${l.title}` : l.title}</td>
                  <td>{human[l.key]?.[0] ?? "—"}</td>
                  <td>{human[l.key]?.[1] ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : column ? (
          <form action={saveHumanScores} className="space-y-2" data-testid="my-column">
            <input type="hidden" name="gold_id" value={gold.id} />
            <input type="hidden" name="rater" value={column} />
            <table className="table text-sm">
              <thead>
                <tr>
                  <th>Criterion and anchors</th>
                  <th>Your score (rater {column})</th>
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
                      <select
                        name={`h${column}:${l.key}`}
                        defaultValue={owners[column] === user.id ? (human[l.key]?.[column - 1] ?? "") : ""}
                        className="input w-24"
                        aria-label={`Rater ${column} score for ${l.key}`}
                      >
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
            <button className="btn">{owners[column] === user.id ? "Save my scores" : `Claim rater ${column} and save my scores`}</button>
          </form>
        ) : free.length ? (
          <div className="flex gap-2 text-sm">
            {free.map((r) => (
              <Link key={r} href={`/admin/calibration/gold/${gold.id}?rater=${r}`} className="btn-secondary">
                Score as rater {r}
              </Link>
            ))}
          </div>
        ) : (
          <p className="muted">Two other people are scoring this sample. The scores and the AI&apos;s grades appear here once both columns are complete.</p>
        )}
      </section>

      {complete ? (
        <details className="space-y-2" open>
          <summary className="cursor-pointer text-sm underline">AI grades from the latest calibration run</summary>
          <RubricBreakdown subjectType="gold" subjectId={gold.id} />
        </details>
      ) : (
        <p className="muted text-sm" data-testid="ai-hidden">
          The AI&apos;s grades for this sample stay hidden until both human columns are complete, so the humans score blind.
        </p>
      )}

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
