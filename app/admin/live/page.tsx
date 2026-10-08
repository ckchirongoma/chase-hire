import Link from "next/link";
import { requireAdmin } from "@/lib/server/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { STAGE_LABEL, STATUS_LABEL } from "@/lib/format";
import { KIND_LABEL, kindsForRole, type ScorecardKind } from "@/lib/live/scorecard";
import { deltaNeedsDiscussion } from "@/lib/live/retest";
import { liveApplications, scorecardCounts, type KindCount } from "@/lib/server/live";

export const dynamic = "force-dynamic";

const SHORT: Record<ScorecardKind, string> = {
  panel_interview: "Panel",
  live_defence: "Defence",
  live_elicitation: "Elicitation",
  exec_scenario: "Exec scenario",
  reasoning_retest: "Retest",
};

function CountCell({ c }: { c: KindCount | undefined }) {
  if (!c) return <span className="muted">—</span>;
  return (
    <span>
      {c.submitted} submitted{c.drafts ? <span className="muted"> · {c.drafts} draft{c.drafts === 1 ? "" : "s"}</span> : null}
      {c.mine && <span className={c.mine === "submitted" ? "badge ml-1" : "badge-warn ml-1"}>you: {c.mine}</span>}
    </span>
  );
}

/**
 * Live stage (docs/01 "live"): shortlisted and live candidates, which scorecards exist per part and
 * how many panellists have submitted. Counts only: scores stay hidden from a panellist until they
 * submit their own card (independent scoring, docs/09 §5).
 */
export default async function LivePage({ searchParams }: { searchParams: Promise<{ role?: string; ok?: string; error?: string }> }) {
  const { supabase, user } = await requireAdmin();
  const { role, ok, error } = await searchParams;
  const apps = await liveApplications(supabase, { role: role || undefined });
  const counts = await scorecardCounts(createAdminClient(), apps.map((a) => a.id), user.id);

  return (
    <div className="space-y-4">
      <h1 className="h1">Live stage ({apps.length})</h1>
      <p className="muted">
        Structured panel interview, live defence of work, BA live elicitation or SWE exec scenario, and the paper reasoning retest.
        Every panellist scores on their own scorecard before any discussion; you see the others&apos; scores for a part only after you
        submit yours, and the final only once you have submitted every part. The final composite is 50% pre-live + 50% live once every
        live part has a submitted scorecard. It sorts; the panel decides, with a written reason, on the candidate page.{" "}
        <Link href="/admin/live/bank" className="underline">Question bank and anchors</Link>
      </p>
      <form className="flex flex-wrap items-center gap-2 text-sm">
        <select name="role" defaultValue={role ?? ""} className="input w-56">
          <option value="">All roles</option>
          <option value="business-analyst">Business Analyst</option>
          <option value="software-engineer">Software Engineer</option>
        </select>
        <button className="btn-secondary">Filter</button>
      </form>
      {error && <p className="error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
      {!apps.length ? (
        <p className="muted">No candidates at the shortlist or live stage.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table" data-testid="live-table">
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Stage</th>
                <th>Scorecards</th>
                <th>Retest</th>
                <th>Scores</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((a) => {
                const c = counts.get(a.id);
                const kinds = kindsForRole(a.roles?.slug ?? "");
                const delta = a.live_delta === null ? null : Number(a.live_delta);
                // The final includes other panellists' scores: shown only once this viewer has submitted every part.
                const mineAll = kinds.length > 0 && kinds.every((k) => c?.get(k)?.mine === "submitted");
                return (
                  <tr key={a.id} data-testid="live-row">
                    <td>
                      <Link href={`/admin/live/${a.id}`} className="font-medium underline">
                        {a.name}
                      </Link>
                      <p className="muted">
                        {a.roles?.title} · {a.email}
                      </p>
                    </td>
                    <td>
                      {STAGE_LABEL[a.stage] ?? a.stage}
                      <p className="muted">{STATUS_LABEL[a.status] ?? a.status}</p>
                    </td>
                    <td className="space-y-1">
                      {kinds.map((k) => (
                        <p key={k}>
                          <span className="text-slate-600">{SHORT[k]}:</span> <CountCell c={c?.get(k)} />
                        </p>
                      ))}
                    </td>
                    <td>
                      <CountCell c={c?.get("reasoning_retest")} />
                      {delta !== null && (
                        <p className={deltaNeedsDiscussion(delta) ? "badge-warn" : "muted"} title={KIND_LABEL.reasoning_retest}>
                          delta {delta}
                          {deltaNeedsDiscussion(delta) ? " · for discussion" : ""}
                        </p>
                      )}
                    </td>
                    <td>
                      <p>Pre-live {a.composite_score ?? "—"}</p>
                      <p className="muted" data-testid="live-row-final">
                        {mineAll ? `Final ${a.final_score ?? "pending"}` : "Final hidden until you submit every part"}
                      </p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
