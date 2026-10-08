import Link from "next/link";
import { fmtDate } from "@/lib/format";
import { DRIFT_BLOCK, DRIFT_PICKS } from "@/lib/calibration/drift";
import type { DriftReport } from "@/lib/server/calibration";

/**
 * Drift check (docs/09 §8.4): for every 25 real submissions graded on this rubric, a person
 * re-scores 3 picked at random (a stable pick) on the candidate page, and the agreement between
 * those re-scores and the AI medians is watched here.
 */
export default function CalibrationDrift({ report }: { report: DriftReport }) {
  const waiting = report.graded % DRIFT_BLOCK;
  return (
    <section className="card space-y-3" data-testid="calibration-drift">
      <h2 className="h2">Drift check</h2>
      <p className="muted">
        Re-score {DRIFT_PICKS} random submissions per {DRIFT_BLOCK} graded: open each, read the evidence and score the criteria by hand (your score replaces the AI
        median for that candidate). {report.graded} graded so far
        {waiting ? `; ${DRIFT_BLOCK - waiting} more until the next pick` : ""}.
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
                  {b.block} <span className="muted">(submissions {(b.block - 1) * DRIFT_BLOCK + 1}–{b.block * DRIFT_BLOCK})</span>
                </td>
                <td className="space-y-1">
                  {b.picks.map((p) => (
                    <p key={p.submissionId}>
                      <Link href={`/admin/candidates/${p.userId}`} className="underline" data-testid="drift-pick">
                        Submission {p.submissionId.slice(0, 8)}
                      </Link>{" "}
                      <span className="muted">{fmtDate(p.createdAt)}</span>{" "}
                      {p.rescored ? <span className="badge">re-scored {p.rescored} criteria</span> : <span className="badge-warn">to re-score</span>}
                    </p>
                  ))}
                </td>
                <td>
                  {b.agreement.n ? (
                    <>
                      {Math.round((b.agreement.within1 ?? 0) * 100)}% within 1 point · mean difference {b.agreement.mad}
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
