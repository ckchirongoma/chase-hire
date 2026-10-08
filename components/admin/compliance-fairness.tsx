import { DIMENSION_LABEL, GROUP_LABEL, type Coverage, type ImpactReport, type ReliabilityRow } from "@/lib/server/compliance";
import { FOUR_FIFTHS, MIN_GROUP_SIZE } from "@/lib/stats/four-fifths";
import { STAGE_LABEL } from "@/lib/format";

/** Display pieces for the fairness sections of /admin/compliance (server components). */

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
const label = (g: string) => GROUP_LABEL[g] ?? g;

/** One row per stage × dimension; the group breakdown opens underneath. */
export function AdverseImpactTable({ reports }: { reports: ImpactReport[] }) {
  const withData = reports.filter((r) => r.rows.length || r.hidden.length);
  if (!withData.length) {
    return <p className="muted">No decisions recorded in this cohort yet.</p>;
  }
  return (
    <table className="table" data-testid="adverse-impact">
      <thead>
        <tr><th>Stage</th><th>Dimension</th><th>Decided</th><th>Lowest impact ratio</th><th>Four-fifths check</th></tr>
      </thead>
      <tbody>
        {withData.map((r) => {
          const compared = r.rows.filter((x) => x.compared);
          const lowest = compared.length ? Math.min(...compared.map((x) => x.ratio ?? 1)) : null;
          return (
            <tr key={`${r.stage}-${r.dimension}`}>
              <td>{STAGE_LABEL[r.stage] ?? r.stage}</td>
              <td>{DIMENSION_LABEL[r.dimension]}</td>
              <td>{r.decided}</td>
              <td>{lowest === null ? "—" : lowest.toFixed(2)}</td>
              <td>
                <details>
                  <summary className="cursor-pointer">
                    {r.flagged.length ? (
                      <span className="badge-bad">Adverse impact: {r.flagged.map(label).join(", ")}</span>
                    ) : r.reference ? (
                      <span className="badge">No group below {FOUR_FIFTHS}</span>
                    ) : (
                      <span className="badge">Not enough groups of {MIN_GROUP_SIZE}+ to compare</span>
                    )}
                  </summary>
                  <table className="table mt-2">
                    <thead>
                      <tr><th>Group</th><th>Decided</th><th>Advanced</th><th>Rate</th><th>Ratio to highest</th></tr>
                    </thead>
                    <tbody>
                      {r.rows.map((g) => (
                        <tr key={g.group}>
                          <td>{label(g.group)}{!g.compared && <span className="muted"> (not compared)</span>}</td>
                          <td>{g.candidates ?? "—"}</td>
                          <td>{g.advanced ?? "—"}</td>
                          <td>{pct(g.rate)}</td>
                          <td>
                            {g.ratio === null ? "—" : g.ratio.toFixed(2)}{" "}
                            {g.flagged && <span className="badge-bad">below {FOUR_FIFTHS}</span>}
                          </td>
                        </tr>
                      ))}
                      {r.hidden.map((g) => (
                        <tr key={`hidden-${g}`}>
                          <td>{label(g)}</td>
                          <td colSpan={4} className="muted">Hidden: fewer than {MIN_GROUP_SIZE} decided</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const BAND: Record<string, { text: string; cls: string }> = {
  too_few: { text: "fewer than 30 attempts: unstable", cls: "badge" },
  low: { text: "below .70: review the items", cls: "badge-bad" },
  acceptable: { text: ".70–.80", cls: "badge-warn" },
  good: { text: ".80 or higher", cls: "badge" },
};

export function ReliabilityTable({ rows }: { rows: ReliabilityRow[] }) {
  if (!rows.length) return <p className="muted">No submitted reasoning attempts yet.</p>;
  return (
    <table className="table" data-testid="kr20">
      <thead>
        <tr><th>Form</th><th>Cohort</th><th>Attempts</th><th>Items</th><th>Mean score</th><th>KR-20</th><th>Reading</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.form}-${r.cohort ?? "all"}`} className={r.cohort ? "" : "font-medium"}>
            <td>{r.form}</td>
            <td>{r.cohort ? r.cohort.slice(0, 7) : "All cohorts"}</td>
            <td>{r.attempts}</td>
            <td>{r.k}</td>
            <td>{r.mean === null ? "—" : r.mean.toFixed(1)}</td>
            <td>{r.kr20 === null ? "—" : r.kr20.toFixed(2)}</td>
            <td>{r.band ? <span className={BAND[r.band].cls}>{BAND[r.band].text}</span> : "undefined (no score variance)"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CoverageTable({ coverage }: { coverage: Coverage }) {
  const share = coverage.candidates ? `${((coverage.respondents / coverage.candidates) * 100).toFixed(0)}%` : "—";
  return (
    <div className="space-y-2" data-testid="demographics-coverage">
      <p className="text-sm">
        {coverage.respondents} of {coverage.candidates} candidates ({share}) filled in the optional form.
      </p>
      {!!coverage.respondents && (
        <table className="table">
          <thead>
            <tr><th>Question</th><th>Answered</th><th>Prefer not to say</th><th>Left blank</th></tr>
          </thead>
          <tbody>
            {coverage.dimensions.map((d) => (
              <tr key={d.dimension}>
                <td>{DIMENSION_LABEL[d.dimension]}</td>
                <td>{d.disclosed}</td>
                <td>{d.preferNot}</td>
                <td>{d.notAnswered}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
