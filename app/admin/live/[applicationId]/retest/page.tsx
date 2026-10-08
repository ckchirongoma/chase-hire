import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { fmtDate } from "@/lib/format";
import { deltaNeedsDiscussion, formCode, LIVE_DELTA_THRESHOLD, LIVE_ITEM_COUNT, LIVE_MINUTES, LIVE_NORM } from "@/lib/live/retest";
import { chooseSeed, loadApplication, onlineReasoning, raterNames, recordedRetest, retestForm } from "@/lib/server/live";
import { RetestKey, RetestSheet } from "@/components/admin/live-retest-form";
import { recordRetest } from "../../actions";

export const dynamic = "force-dynamic";

const PRINT_CSS = `
.retest-table { border-collapse: collapse; }
.retest-table th, .retest-table td { border: 1px solid #cbd5e1; padding: 2px 6px; text-align: left; }
@media print {
  @page { margin: 14mm; }
  body { background: #fff !important; }
  body > header, body > footer, nav, .no-print { display: none !important; }
  main { max-width: none !important; padding: 0 !important; }
  .retest-item { break-inside: avoid; }
  .retest-key { break-before: page; }
}
`;

/**
 * Paper reasoning retest (docs/04 §2 and §6): a fresh 12-item parallel form from the live pool
 * with a per-candidate seed (items the candidate saw online are excluded), the answer key on its
 * own printed page, then the score entry. live_delta = online percentile − live percentile; above
 * 25 points it is flagged for discussion, never as a rejection, and it is not part of the composite.
 */
export default async function RetestPage({
  params,
  searchParams,
}: {
  params: Promise<{ applicationId: string }>;
  searchParams: Promise<{ seed?: string; ok?: string; error?: string }>;
}) {
  const { supabase } = await requireAdmin();
  const { applicationId } = await params;
  const { seed: requested, ok, error } = await searchParams;
  if (!z.uuid().safeParse(applicationId).success) notFound();
  const app = await loadApplication(supabase, applicationId);
  if (!app) notFound();

  // One retest per candidate. Once recorded, its seed keeps reprints identical; it is an objective
  // count (not a panellist's judgement), so every admin sees it.
  const service = createAdminClient();
  const recorded = await recordedRetest(service, app.id);
  const seed = chooseSeed(app.id, recorded ? undefined : requested, recorded?.seed && Number.isInteger(recorded.seed) && recorded.seed > 0 ? recorded.seed : null);

  const [items, online, profile] = await Promise.all([
    retestForm(supabase, app.user_id, seed),
    onlineReasoning(supabase, app.user_id),
    supabase.from("profiles").select("full_name").eq("user_id", app.user_id).maybeSingle(),
  ]);
  const recordedBy = recorded ? (await raterNames(service, [recorded.rater])).get(recorded.rater) : null;
  const reference = `${app.id.slice(0, 8)}-${formCode(seed)}`;
  const another = Math.floor(Math.random() * 2_000_000_000) + 1;

  return (
    <div className="space-y-6">
      <style>{PRINT_CSS}</style>
      <div className="no-print space-y-3">
        <p className="text-sm">
          <Link href={`/admin/live/${app.id}`} className="underline">
            ← {profile.data?.full_name || "Candidate"}: live stage
          </Link>
        </p>
        <h1 className="h1">Reasoning retest: {app.roles?.title}</h1>
        {error && <p className="error">{error}</p>}
        {ok && <p className="notice">{ok}</p>}
        <div className="card space-y-2 text-sm">
          <p>
            Print this page: the candidate&apos;s sheet ({LIVE_ITEM_COUNT} questions, {LIVE_MINUTES} minutes, timed by you), then the answer key on a separate page for
            you. The form is generated from the live pool with this candidate&apos;s seed ({seed}); questions they saw online are left out. Reprints show the same form.{" "}
            {recorded ? (
              <span className="muted">This is the form the recorded retest used.</span>
            ) : (
              <Link href={`/admin/live/${app.id}/retest?seed=${another}`} className="underline">
                Generate a different form
              </Link>
            )}
          </p>
          <p className="muted">
            Online result:{" "}
            {online?.percentile != null
              ? `${online.raw_score ?? "?"}/30, percentile ${online.percentile} (${online.norm_version ?? "norm unknown"})`
              : "no submitted online attempt"}
            . Live norm: {LIVE_NORM.version} (mean {LIVE_NORM.mean}, SD {LIVE_NORM.sd} on 12 items, equated to the online applicant-pool norm).
          </p>
        </div>

        <section className="card space-y-3" id="enter">
          <h2 className="h2">Enter the score</h2>
          {recorded ? (
            <div className="space-y-1 text-sm" data-testid="retest-recorded">
              <p>
                Recorded by {recordedBy} on {fmtDate(recorded.submittedAt)}: {recorded.raw ?? "?"}/{LIVE_ITEM_COUNT}, live percentile {recorded.livePercentile ?? "—"}
                {recorded.onlinePercentile !== null ? `, online percentile ${recorded.onlinePercentile}` : ""}
                {recorded.delta !== null ? `, delta ${recorded.delta}` : ""}{" "}
                {deltaNeedsDiscussion(recorded.delta) && <span className="badge-warn">for discussion</span>}
              </p>
              <p className="muted">One retest per candidate. It is final and can&apos;t be recorded again.</p>
            </div>
          ) : (
            <form action={recordRetest} className="flex flex-wrap items-end gap-3 text-sm">
              <input type="hidden" name="application_id" value={app.id} />
              <input type="hidden" name="seed" value={seed} />
              <div>
                <label className="label" htmlFor="raw">
                  Raw score (0 to {LIVE_ITEM_COUNT})
                </label>
                <input id="raw" name="raw" type="number" min={0} max={LIVE_ITEM_COUNT} step={1} required className="input w-32" />
              </div>
              <button className="btn">Record retest (final, one per candidate)</button>
            </form>
          )}
          <p className="muted">
            Delta = online percentile − live percentile. Above {LIVE_DELTA_THRESHOLD} points it is flagged for discussion in the room: ask the candidate about it.
            It never rejects anyone and is not part of the composite.
          </p>
        </section>
      </div>

      <RetestSheet items={items} reference={reference} />
      <RetestKey items={items} seed={seed} reference={reference} />
    </div>
  );
}
