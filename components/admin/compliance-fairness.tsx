import { DIMENSION_LABEL, GROUP_LABEL, type Coverage, type ImpactReport, type ReliabilityRow } from "@/lib/server/compliance";
import { FOUR_FIFTHS, MIN_GROUP_SIZE } from "@/lib/stats/four-fifths";
import { STAGE_LABEL } from "@/lib/format";

/** Display pieces for the fairness sections of /admin/compliance (server components). */

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
const label = (g: string) => GROUP_LABEL[g] ?? g;

/** One row per stage × dimension; the group breakdown opens underneath. */
export function AdverseImpactTable({ reports }: { reports: ImpactReport[] }) {
  const withData = reports.filter((r) => r.rows.length);
  if (!withData.length) {
    return (
      <p className="muted">
        Nothing to show for this cohort: no stage has a group with {MIN_GROUP_SIZE} or more decided applications whose
        complement is also {MIN_GROUP_SIZE} or more (and with no small remainder of 1 to {MIN_GROUP_SIZE - 1} people outside
        the shown groups). Smaller groups are never shown, named or counted.
      </p>
    );
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
                    </tbody>
                  </table>
                  <p className="muted mt-1 text-xs">
                    Groups with fewer than {MIN_GROUP_SIZE} decided applications are not listed, named or counted, so these rows
                    need not add up to everyone decided (when they don&apos;t, the people left out number {MIN_GROUP_SIZE} or more).
                  </p>
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

const small = `fewer than ${MIN_GROUP_SIZE}`;
const shown = (n: number | null) => (n === null ? <span className="muted">not shown</span> : n);

/**
 * How many candidates filled in the optional form. Counts from 1 to 29 are never shown (the
 * consent promises totals for groups of 30 or more only), so a change right after one person
 * visits can't reveal their answer.
 */
export function CoverageTable({ coverage }: { coverage: Coverage }) {
  if (coverage.respondents === null) {
    return (
      <p className="text-sm" data-testid="demographics-coverage">
        {small} of {coverage.candidates} candidates filled in the optional form. Totals appear once {MIN_GROUP_SIZE} or more
        have answered.
      </p>
    );
  }
  const share = coverage.candidates ? `${((coverage.respondents / coverage.candidates) * 100).toFixed(0)}%` : "—";
  return (
    <div className="space-y-2" data-testid="demographics-coverage">
      <p className="text-sm">
        {coverage.respondents} of {coverage.candidates} candidates ({share}) filled in the optional form.
      </p>
      {!!coverage.respondents && (
        <>
          <table className="table">
            <thead>
              <tr><th>Question</th><th>Answered</th><th>Prefer not to say</th><th>Left blank</th></tr>
            </thead>
            <tbody>
              {coverage.dimensions.map((d) => (
                <tr key={d.dimension}>
                  <td>{DIMENSION_LABEL[d.dimension]}</td>
                  <td>{shown(d.disclosed)}</td>
                  <td>{shown(d.preferNot)}</td>
                  <td>{shown(d.notAnswered)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted text-xs">
            &ldquo;Not shown&rdquo;: one of that question&apos;s three counts is {small}, so none of the three is shown (any two
            would give away the third).
          </p>
        </>
      )}
    </div>
  );
}
