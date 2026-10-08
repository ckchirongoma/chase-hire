import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { fmtDate, STAGE_LABEL, STATUS_LABEL } from "@/lib/format";
import { liveWeights } from "@/lib/scoring/composite";
import { KIND_LABEL, viewerLiveScores } from "@/lib/live/scorecard";
import { deltaNeedsDiscussion, LIVE_DELTA_THRESHOLD } from "@/lib/live/retest";
import { computeScores } from "@/lib/server/scores";
import { LIVE_STAGES, loadApplication, questionsFor, raterNames, recordedRetest, scorecardCounts, visibleScorecards } from "@/lib/server/live";
import LiveScorecard from "@/components/admin/live-scorecard";

export const dynamic = "force-dynamic";

/**
 * One candidate's live stage: a scorecard per live part for the signed-in panellist, the AI
 * interview's verification concerns (two panel questions are built from them), the scores so far,
 * and the retest delta. Scores are advisory; the decision is made on the candidate page.
 */
export default async function LiveCandidatePage({
  params,
  searchParams,
}: {
  params: Promise<{ applicationId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { supabase, user } = await requireAdmin();
  const { applicationId } = await params;
  const { ok, error } = await searchParams;
  if (!z.uuid().safeParse(applicationId).success) notFound();
  const app = await loadApplication(supabase, applicationId);
  if (!app) notFound();
  const role = app.roles?.slug ?? "";
  const service = createAdminClient();

  const [{ byKind, kinds, concerns, followups }, cards, counts, [score], profile, retest] = await Promise.all([
    questionsFor(supabase, role, app.id),
    visibleScorecards(supabase, app.id, user.id),
    scorecardCounts(service, [app.id], user.id),
    computeScores(service, { applicationIds: [app.id] }),
    supabase.from("profiles").select("full_name, email").eq("user_id", app.user_id).maybeSingle(),
    recordedRetest(service, app.id),
  ]);
  const names = await raterNames(service, cards.map((c) => c.rater));
  const kindCounts = counts.get(app.id);
  // Live and final scores from the cards this panellist may read (RLS), never from the service
  // role: a part's score shows only after they submit it, the final only after every part.
  const seen = viewerLiveScores(role, cards, user.id, score?.preLive ?? null);
  const waiting = kinds.filter((k) => !(kindCounts?.get(k)?.submitted ?? 0));
  const weights = liveWeights(role);
  const delta = app.live_delta === null ? null : Number(app.live_delta);
  const open = (LIVE_STAGES as readonly string[]).includes(app.stage);

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link href="/admin/live" className="underline">
          ← Live stage
        </Link>
      </p>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="h1">
          {profile.data?.full_name || "(no name)"} <span className="muted">· {app.roles?.title}</span>
        </h1>
        <p className="text-sm">
          {STAGE_LABEL[app.stage] ?? app.stage} · {STATUS_LABEL[app.status] ?? app.status} ·{" "}
          <Link href={`/admin/candidates/${app.user_id}`} className="underline">
            Candidate page (evidence and decision)
          </Link>
        </p>
        {!seen.allSubmitted && (
          <p className="muted text-xs" data-testid="candidate-page-caution">
            Score blind: until you have submitted every part here, don&apos;t read live or final scores elsewhere (they may include other panellists&apos; cards).
          </p>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}

      <section className="card grid gap-4 text-sm sm:grid-cols-3" data-testid="live-scores">
        <div>
          <p className="muted">Pre-live composite</p>
          <p className="text-lg font-semibold">{score?.preLive.score ?? "—"}</p>
          <p className="muted">{score ? `${Math.round(score.preLive.coverage * 100)}% of the weight present` : ""}</p>
        </div>
        <div data-testid="live-score">
          <p className="muted">Live stage (submitted scorecards)</p>
          {seen.hidden.length === kinds.length ? (
            <p className="muted">Hidden until you submit your own scorecards.</p>
          ) : (
            <>
              <p className="text-lg font-semibold">{seen.live.score ?? "—"}</p>
              <p className="muted">
                {seen.hidden.length
                  ? `Over the parts you have submitted. Hidden until you submit yours: ${seen.hidden.map((k) => KIND_LABEL[k]).join(", ")}.`
                  : "Every part: the mean of all submitted scorecards."}
              </p>
            </>
          )}
          <p className="muted">{waiting.length ? `Waiting for a first scorecard: ${waiting.map((k) => KIND_LABEL[k]).join(", ")}.` : "Every part has a submitted scorecard."}</p>
        </div>
        <div>
          <p className="muted">Final (50% pre-live + 50% live)</p>
          {seen.allSubmitted ? (
            <p className="text-lg font-semibold" data-testid="final-score">
              {seen.final ?? "pending"}
            </p>
          ) : (
            <p className="muted" data-testid="final-score">
              Hidden until you have submitted every live part.
            </p>
          )}
          <p className="muted">Sorts the shortlist. The panel decides, with a reason that references the criteria.</p>
        </div>
      </section>

      <section className="card space-y-2 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="h2">Reasoning retest (parallel form, 12 items in 6 minutes)</h2>
          <Link href={`/admin/live/${app.id}/retest`} className="btn-secondary">
            Print the form and enter the score
          </Link>
        </div>
        {retest && (
          <p className="muted">
            Recorded {retest.raw ?? "?"}/12 (live percentile {retest.livePercentile ?? "—"}) on {fmtDate(retest.submittedAt)}. One retest per candidate; it is final.
          </p>
        )}
        {delta !== null ? (
          <p data-testid="retest-delta">
            Online percentile minus live percentile: <strong>{delta}</strong>{" "}
            {deltaNeedsDiscussion(delta) ? (
              <span className="badge-warn">for discussion: ask about it in the room</span>
            ) : (
              <span className="badge">within {LIVE_DELTA_THRESHOLD} points</span>
            )}
          </p>
        ) : (
          <p className="muted">{retest ? "Recorded, but there is no online attempt to compare with." : "Not recorded yet."}</p>
        )}
        <p className="muted">
          The retest is not part of any composite. A large delta is a prompt for a conversation, never a rejection on its own.
        </p>
      </section>

      <section className="card space-y-2 text-sm" data-testid="verification-concerns">
        <h2 className="h2">From the AI interview</h2>
        {concerns.length ? (
          <>
            <p className="muted">
              Verification concerns ({concerns.length}). The first {Math.min(2, concerns.length)} replace{concerns.length === 1 ? "s" : ""} a panel question below.
            </p>
            <ul className="ml-5 list-disc">
              {concerns.map((c, i) => (
                <li key={i}>
                  <strong>{c.claim}</strong>
                  {c.reason ? <span className="text-slate-600"> · {c.reason}</span> : null}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted">No verification concerns: the panel uses the bank questions for all six slots.</p>
        )}
        {followups.length > 0 && (
          <>
            <p className="muted">Suggested follow-ups:</p>
            <ul className="ml-5 list-disc">
              {followups.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      {kinds.map((kind) => (
        <LiveScorecard
          key={kind}
          applicationId={app.id}
          kind={kind}
          weight={weights[kind] ?? 0}
          questions={byKind.get(kind) ?? []}
          mine={cards.find((c) => c.kind === kind && c.rater === user.id) ?? null}
          others={cards.filter((c) => c.kind === kind && c.rater !== user.id && c.submitted_at)}
          names={names}
          count={kindCounts?.get(kind)}
          disabled={!open}
        />
      ))}
    </div>
  );
}
