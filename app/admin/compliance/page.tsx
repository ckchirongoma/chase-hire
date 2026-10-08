import Link from "next/link";
import { requireAdmin } from "@/lib/server/auth";
import {
  adverseImpactAll,
  CohortFilter,
  demographicsCoverage,
  profileNames,
  reliability,
  retentionOverview,
} from "@/lib/server/compliance";
import { countDue, purgeDue, retentionPepper, type PurgeReport } from "@/lib/server/retention";
import { createAdminClient } from "@/lib/supabase/admin";
import { FOUR_FIFTHS, MIN_GROUP_SIZE } from "@/lib/stats/four-fifths";
import { DryRunTable, InProgressTable, PurgeLogTable, RetentionQueueTable } from "@/components/admin/compliance-retention";
import { AdverseImpactTable, CoverageTable, ReliabilityTable } from "@/components/admin/compliance-fairness";
import { purgeNow } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Compliance (docs/01 "Admin", docs/09 §9, docs/12): the retention queue and purge log, review
 * requests, the adverse-impact report with the four-fifths check, reasoning-test reliability
 * (KR-20) and how many candidates shared optional demographics. Nothing here shows a person's
 * demographics; the reports are aggregates computed in the database.
 */
export default async function CompliancePage({
  searchParams,
}: {
  searchParams: Promise<{ dry?: string; ok?: string; error?: string; role?: string; from?: string; to?: string }>;
}) {
  const { supabase } = await requireAdmin();
  const sp = await searchParams;
  const filter = CohortFilter.parse({ role: sp.role || undefined, from: sp.from || undefined, to: sp.to || undefined });

  const [overview, impact, kr20, coverage, { data: roles }] = await Promise.all([
    retentionOverview(supabase),
    adverseImpactAll(supabase, filter),
    reliability(supabase),
    demographicsCoverage(supabase),
    supabase.from("roles").select("slug, title").order("title"),
  ]);

  let pepperProblem: string | null = null;
  try {
    retentionPepper();
  } catch (err) {
    pepperProblem = err instanceof Error ? err.message : String(err);
  }

  // Service role after the admin check, read-only: the live count to confirm (the queue table
  // is as of the last sweep) and the dry run, which is a plain GET for that reason.
  const service = createAdminClient();
  const live = await countDue(service);
  const toConfirm = live.due + live.inProgress;
  let dryRun: PurgeReport | null = null;
  let dryNames = new Map<string, string>();
  if (sp.dry === "1") {
    dryRun = await purgeDue(service, { dryRun: true, limit: 200 });
    dryNames = await profileNames(supabase, dryRun.planned.map((p) => p.userId));
  }
  const filterQuery = new URLSearchParams(Object.entries(filter).filter((e): e is [string, string] => !!e[1]));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="h1">Compliance</h1>
        <p className="muted">
          POPIA retention and the purge log, candidates&apos; review requests, and the fairness checks docs/09 §9 asks for each
          cohort. Item statistics for the reasoning bank are on <Link href="/admin/banks" className="underline">Banks</Link>.
        </p>
      </div>
      {sp.error && <p className="error">{sp.error}</p>}
      {sp.ok && <p className="notice">{sp.ok}</p>}

      <section className="card space-y-2">
        <h2 className="h2">Review requests</h2>
        <p className="text-sm">
          {overview.openReviewRequests} open.{" "}
          <Link href="/admin/reviews" className="underline">Answer them on Review requests</Link>. Candidates use them to contest a
          score or decision (POPIA s71) and to ask for accommodations. Someone with an open request is never purged.
        </p>
      </section>

      <section id="retention" className="card space-y-4">
        <h2 className="h2">Retention</h2>
        <p className="muted">
          As the privacy notice promises: if someone is not appointed, their information is deleted 6 months after their
          application closed (12 months if they opted into the talent pool on their latest consent). Someone who never applied
          is deleted 6 months after their last activity. Admins, anyone with an application still in play and appointed
          candidates are never queued. A purge keeps only a decision log under a hashed id and anonymised item answers; it
          deletes the CV, recordings, submissions, snapshots and the account. The nightly sweep purges up to 25 people a run.
        </p>
        {pepperProblem && <p className="error">{pepperProblem}</p>}
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="muted">Queued</dt><dd className="text-xl font-semibold">{overview.queued}</dd></div>
          <div><dt className="muted">Due now</dt><dd className="text-xl font-semibold">{overview.dueNow}</dd></div>
          <div><dt className="muted">Due in 30 days</dt><dd className="text-xl font-semibold">{overview.dueIn30Days}</dd></div>
          <div><dt className="muted">Talent pool</dt><dd className="text-xl font-semibold">{overview.talentPool}</dd></div>
        </dl>
        <p className="muted">
          The queue is as of the last nightly sweep. Right now {live.due} {live.due === 1 ? "person is" : "people are"} due
          {live.inProgress ? ` and ${live.inProgress} purge${live.inProgress === 1 ? " is" : "s are"} unfinished` : ""}; a purge
          re-checks every person before deleting anything.
        </p>

        <div className="flex flex-wrap items-end gap-4">
          <Link href="/admin/compliance?dry=1#retention" className="btn-secondary">Dry run: who would be purged now</Link>
          <form action={purgeNow} className="flex flex-wrap items-end gap-2 text-sm">
            <label>
              <span className="label">Type {toConfirm} to confirm</span>
              <input name="confirm" type="number" min={0} required className="input w-28" />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="ack" required /> I understand a purge can&apos;t be undone
            </label>
            <button className="btn" disabled={toConfirm === 0}>Purge now</button>
          </form>
        </div>

        {dryRun && (
          <div className="space-y-2">
            <h3 className="font-semibold">
              Dry run ({dryRun.today}): {dryRun.due} due{dryRun.inProgress ? `, ${dryRun.inProgress} in progress` : ""}. Nothing was changed.
            </h3>
            <DryRunTable rows={dryRun.planned} names={dryNames} />
            {dryRun.remaining > 0 && <p className="muted">{dryRun.remaining} more not shown.</p>}
          </div>
        )}

        <InProgressTable rows={overview.inProgress} />

        <div className="space-y-2">
          <h3 className="font-semibold">Queue (next {overview.next.length})</h3>
          <RetentionQueueTable rows={overview.next} today={overview.today} />
        </div>
        <div className="space-y-2">
          <h3 className="font-semibold">Purge log (latest {overview.log.length})</h3>
          <p className="muted">Ids are sha256 hashes with a server-only pepper, so a dispute can be matched without keeping the person.</p>
          <PurgeLogTable rows={overview.log} />
        </div>
      </section>

      <section id="fairness" className="card space-y-4">
        <h2 className="h2">Adverse impact</h2>
        <p className="muted">
          Advance rates by group at each stage, counting applications an admin decided there (advance or reject; holds and
          undecided ones are left out). A group whose rate is below {FOUR_FIFTHS} of the highest group&apos;s rate is flagged (the
          four-fifths rule): review that stage&apos;s items and anchors before the next cohort. A flag is about the assessment,
          never about a candidate. Groups with fewer than {MIN_GROUP_SIZE} decided applications are hidden: rates on small
          groups swing on one or two people, and showing them could identify someone. &ldquo;Not disclosed&rdquo; and
          &ldquo;prefer not to say&rdquo; are shown but not compared.
        </p>
        <form className="flex flex-wrap items-end gap-3 text-sm" action="/admin/compliance#fairness">
          <label>
            <span className="label">Role</span>
            <select name="role" defaultValue={filter.role ?? ""} className="input">
              <option value="">All roles</option>
              {(roles ?? []).map((r) => (
                <option key={r.slug} value={r.slug}>{r.title}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">Applied from</span>
            <input type="date" name="from" defaultValue={filter.from ?? ""} className="input" />
          </label>
          <label>
            <span className="label">to</span>
            <input type="date" name="to" defaultValue={filter.to ?? ""} className="input" />
          </label>
          <button className="btn-secondary">Show cohort</button>
          {filterQuery.size > 0 && <Link href="/admin/compliance#fairness" className="underline">Clear</Link>}
        </form>
        <AdverseImpactTable reports={impact} />
      </section>

      <section id="reliability" className="card space-y-4">
        <h2 className="h2">Reasoning Assessment reliability (KR-20)</h2>
        <p className="muted">
          Internal consistency per form and cohort (the month the attempt started), from every submitted attempt plus the
          anonymised answers kept after purges. Each of the 30 positions is an item (its tier is fixed by the blueprint); a
          skipped item counts as wrong. Docs 04 and 09 ask for it every cohort; .70 and .80 are the usual reading points for a
          screening test, not decision rules.
        </p>
        <ReliabilityTable rows={kr20} />
      </section>

      <section id="demographics" className="card space-y-4">
        <h2 className="h2">Optional demographics</h2>
        <p className="muted">
          Candidates can share population group, gender and disability on a separate, voluntary form (/me/demographics) that
          graders and raters never see and decisions never use. Admins see only these totals and the aggregates above.
        </p>
        <CoverageTable coverage={coverage} />
      </section>
    </div>
  );
}
