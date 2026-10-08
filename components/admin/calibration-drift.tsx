import Link from "next/link";
import { fmtDate } from "@/lib/format";
import { DRIFT_BLOCK, DRIFT_PICKS } from "@/lib/calibration/drift";
import type { DriftReport } from "@/lib/server/calibration";

/**
 * Drift check (docs/09 §8.4): for every 25 real submissions graded on this rubric, a person
 * re-scores 3 picked at random. Each block and its picks are frozen when the block fills, so the
 * list never reshuffles. Re-scores are kept apart (drift_rescores): they never change a candidate's
 * score; only the agreement with the AI medians is watched here.
 */
export default function CalibrationDrift({ report }: { report: DriftReport }) {
  return (
    <section className="card space-y-3" data-testid="calibration-drift">
      <h2 className="h2">Drift check</h2>
      <p className="muted">
        Re-score {DRIFT_PICKS} random submissions per {DRIFT_BLOCK} graded: open each pick, read the submission and score the criteria by hand. Drift re-scores are
        kept apart from review overrides and never change the candidate&apos;s score. {report.graded} graded so far
        {report.waiting ? `; ${DRIFT_BLOCK - report.waiting} more until the next block` : ""}.
      </p>
      {!report.blocks.length ? (
        <p className="muted">No complete block of {DRIFT_BLOCK} graded submissions yet.</p>
      ) : (
        <table className="table text-sm">
          <thead>
            <tr>
              <th>Block</th>
              <th>Re-score these</th>
              <th>Agreement on re-scored criteria</th>
            </tr>
          </thead>
          <tbody>
            {report.blocks.map((b) => (
              <tr key={b.block}>
                <td>
                  {b.block} <span className="muted">(frozen {fmtDate(b.frozenAt)})</span>
                </td>
                <td className="space-y-1">
                  {b.picks.map((p) => (
                    <p key={p.submissionId}>
                      {p.userId ? (
                        <Link href={`/admin/calibration/drift/${p.submissionId}?rubric=${report.rubricKey}`} className="underline" data-testid="drift-pick">
                          Submission {p.submissionId.slice(0, 8)}
                        </Link>
                      ) : (
                        <span className="muted">Submission {p.submissionId.slice(0, 8)} (no longer stored)</span>
                      )}{" "}
                      {p.createdAt && <span className="muted">{fmtDate(p.createdAt)}</span>}{" "}
                      {p.rescoredByMe ? (
                        <span className="badge">you re-scored {p.rescoredByMe}</span>
                      ) : p.rescored ? (
                        <span className="badge">re-scored {p.rescored} criteria</span>
                      ) : p.userId ? (
                        <span className="badge-warn">to re-score</span>
                      ) : null}
                    </p>
                  ))}
                </td>
                <td>
                  {b.agreement.n ? (
                    <>
                      {Math.round((b.agreement.within1 ?? 0) * 100)}% within 1 point · mean difference {b.agreement.mad} ({b.agreement.n} scores)
                      {(b.agreement.within1 ?? 1) < 0.8 && <span className="badge-warn ml-1">watch: agreement is slipping</span>}
                    </>
                  ) : (
                    <span className="muted">no re-scores yet</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
