import Link from "next/link";
import { fmtDate } from "@/lib/format";
import { agreementBand, ICC_LIVE, ICC_REVIEW, MIN_GOLD, STATUS_LABEL, type CalibrationStatus } from "@/lib/calibration/stats";
import type { CalibrationRunRow } from "@/lib/server/calibration";

/**
 * Calibration report for one finished run (docs/09 §8): per calibrated criterion, ICC(2,1)
 * (absolute agreement) and quadratic weighted kappa between the AI's final score and the mean of
 * the two human raters, the human-vs-human ICC for reference, and the go-live status the grading
 * core applies to real grades.
 */

const STATUS_CLASS: Record<CalibrationStatus, string> = { live: "badge", review: "badge-warn", human_only: "badge-bad" };

export function StatusBadge({ status }: { status: CalibrationStatus }) {
  return (
    <span className={STATUS_CLASS[status]} data-testid="calibration-status">
      {STATUS_LABEL[status]}
    </span>
  );
}

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(2));

export default function CalibrationReport({ run, changed }: { run: CalibrationRunRow; changed: string[] }) {
  const rows = Object.entries(run.per_criterion ?? {});
  const counts = rows.reduce<Record<string, number>>((m, [, v]) => ({ ...m, [v.status]: (m[v.status] ?? 0) + 1 }), {});
  return (
    <div className="space-y-3" data-testid="calibration-report">
      <p className="text-sm">
        Run of {fmtDate(run.finished_at ?? run.ran_at)} · rubric v{run.rubric_version} · model {run.model} · prompts {run.prompt_versions.join(", ") || "—"} ·{" "}
        {run.passed ? <span className="badge">passed: every criterion live</span> : <span className="badge-warn">not passed</span>}{" "}
        <span className="muted">
          ({counts.live ?? 0} live, {counts.review ?? 0} review, {counts.human_only ?? 0} human-only)
        </span>
      </p>
      {changed.length > 0 && (
        <p className="notice">
          Changed since this run: {changed.join("; ")}. Re-run the gold set before relying on these statuses (CLAUDE.md: any rubric, prompt or model change).
        </p>
      )}
      {run.error && <p className="muted">Note: {run.error}</p>}
      <div className="overflow-x-auto">
        <table className="table text-sm">
          <thead>
            <tr>
              <th>Criterion</th>
              <th title="Gold samples with an AI score and both human scores">n</th>
              <th title="ICC(2,1), absolute agreement: AI final vs mean human">ICC</th>
              <th title="Quadratic weighted kappa on the 1–5 scale (scores rounded)">QWK</th>
              <th title="Human rater 1 vs rater 2, ICC(2,1)">Human ICC</th>
              <th>Mean AI / human</th>
              <th>Go-live status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([key, c]) => (
              <tr key={key} data-testid="calibration-row" data-key={key}>
                <td>
                  <p>{c.parent ? `${c.parent} › ${c.title ?? key}` : (c.title ?? key)}</p>
                  <p className="muted text-xs">{key}</p>
                  {c.notes?.length ? <p className="text-xs text-amber-700">{c.notes.join(" · ")}</p> : null}
                </td>
                <td>{c.n}</td>
                <td>
                  {fmt(c.icc)} <span className="muted text-xs">{agreementBand(c.icc)}</span>
                </td>
                <td>{fmt(c.qwk)}</td>
                <td>{fmt(c.human_icc)}</td>
                <td>
                  {fmt(c.mean_ai)} / {fmt(c.mean_human)}
                </td>
                <td>
                  <StatusBadge status={c.status} />
                  {c.pairs?.length ? (
                    <details className="mt-1 text-xs">
                      <summary className="cursor-pointer underline">pairs</summary>
                      <table className="table text-xs">
                        <tbody>
                          {c.pairs.map((p) => (
                            <tr key={p.gold_id}>
                              <td>
                                <Link href={`/admin/calibration/gold/${p.gold_id}`} className="underline">
                                  {p.gold_id.slice(0, 8)}
                                </Link>
                              </td>
                              <td>AI {p.ai}</td>
                              <td>
                                humans {p.human[0]}, {p.human[1]}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted text-xs">
        Go-live rule (docs/09 §8): ICC ≥ {ICC_LIVE} live; {ICC_REVIEW}–{ICC_LIVE} live with mandatory human review (every grade of that criterion is flagged
        &quot;calibration: review&quot;); below {ICC_REVIEW}, or fewer than {MIN_GOLD} usable gold samples, human-scored only (flagged &quot;calibration: human_only&quot;).
        Agreement bands: below .50 poor, .50–.75 moderate, .75–.90 good.
      </p>
    </div>
  );
}
