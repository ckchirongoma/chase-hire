import Link from "next/link";
import { requireAdmin } from "@/lib/server/auth";
import { computeScores, type AppScore } from "@/lib/server/scores";
import { createAdminClient } from "@/lib/supabase/admin";
import { inChunks } from "@/lib/server/query";
import { STAGE_LABEL } from "@/lib/format";
import PipelineColumn, { type CardData } from "./column";
import { BATCH_ELIGIBLE_STATUSES } from "./eligibility";

export const dynamic = "force-dynamic";

const COLUMNS = ["interview", "quiz", "work_1", "work_2", "grading", "shortlist", "live", "offer"] as const;
const CLOSED_STATUSES = ["rejected", "withdrawn"];

/**
 * Kanban of applications by stage (docs/01 "Admin"). Cards are sorted by the pre-live composite,
 * which only sorts: every advance or reject is an individual admin decision with a reason, except
 * a confirmed batch advance of candidates who finished their stage.
 */
export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string; blind?: string; closed?: string; ok?: string; error?: string }>;
}) {
  await requireAdmin();
  const { role, blind, closed, ok, error } = await searchParams;
  const admin = createAdminClient();
  let scores = await computeScores(admin);
  if (role) scores = scores.filter((s) => s.roleSlug === role);
  if (!closed) scores = scores.filter((s) => !CLOSED_STATUSES.includes(s.status) && s.stage !== "closed");

  const userIds = [...new Set(scores.map((s) => s.userId))];
  const profiles = await inChunks<{ user_id: string; full_name: string | null; email: string | null }>(userIds, (c) =>
    admin.from("profiles").select("user_id, full_name, email").in("user_id", c),
  );
  const names = new Map(profiles.map((p) => [p.user_id, { name: p.full_name || "(no name)", email: p.email ?? "" }]));

  const params = new URLSearchParams();
  if (role) params.set("role", role);
  if (blind) params.set("blind", "1");
  if (closed) params.set("closed", "1");
  const back = `/admin/pipeline${params.size ? `?${params}` : ""}`;
  const toggle = (key: string) => {
    const p = new URLSearchParams(params);
    if (p.has(key)) p.delete(key);
    else p.set(key, "1");
    return `/admin/pipeline${p.size ? `?${p}` : ""}`;
  };

  const card = (s: AppScore): CardData => ({
    applicationId: s.applicationId,
    userId: s.userId,
    label: blind ? `Candidate ${s.applicationId.slice(0, 8)}` : (names.get(s.userId)?.name ?? "(no name)"),
    sub: blind ? null : (names.get(s.userId)?.email ?? null),
    roleTitle: s.roleTitle,
    status: s.status,
    composite: s.preLive.score,
    coverage: s.preLive.coverage,
    final: s.final,
    execComms: s.execComms.score,
    eligible: BATCH_ELIGIBLE_STATUSES.includes(s.status),
    flags: [
      s.belowHurdle ? `below hurdle (${s.reasoningStars ?? "?"}★)` : null,
      s.flags.openDedupe ? `${s.flags.openDedupe} dedupe` : null,
      s.flags.openReviewRequests ? "review requested" : null,
      s.flags.gradesNeedingReview ? `${s.flags.gradesNeedingReview} grades to review` : null,
      s.flags.lockedSessions ? "locked session" : null,
      s.flags.injectionSignals ? "injection signal" : null,
      s.flags.submissionFlags ? `${s.flags.submissionFlags} submission flag${s.flags.submissionFlags === 1 ? "" : "s"}` : null,
      s.liveDelta !== null && s.liveDelta > 25 ? `live delta ${s.liveDelta}` : null,
    ].filter((f): f is string => f !== null),
  });

  const byStage = new Map<string, CardData[]>();
  for (const s of [...scores].sort((a, b) => (b.preLive.score ?? -1) - (a.preLive.score ?? -1))) {
    const col = (COLUMNS as readonly string[]).includes(s.stage) ? s.stage : "offer";
    byStage.set(col, [...(byStage.get(col) ?? []), card(s)]);
  }

  return (
    <div className="space-y-4">
      <h1 className="h1">Pipeline ({scores.length})</h1>
      <p className="muted">
        Sorted by the pre-live composite (docs/09), shown with how much of it exists so far. Scores sort the queue; they never
        decide. Open a candidate to read the evidence and record an individual decision. Batch advance is only for candidates
        who finished their stage, needs one reason that references the criteria, and asks you to confirm the count. There is no
        batch reject.
      </p>
      <form className="flex flex-wrap items-center gap-2 text-sm">
        <select name="role" defaultValue={role ?? ""} className="input w-48">
          <option value="">All roles</option>
          <option value="business-analyst">Business Analyst</option>
          <option value="software-engineer">Software Engineer</option>
        </select>
        {blind && <input type="hidden" name="blind" value="1" />}
        {closed && <input type="hidden" name="closed" value="1" />}
        <button className="btn-secondary">Filter</button>
        <Link href={toggle("blind")} className="underline">{blind ? "Show names" : "Blind review (hide names)"}</Link>
        <Link href={toggle("closed")} className="underline">{closed ? "Hide closed" : "Show closed"}</Link>
      </form>
      {error && <p className="error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
      <div className="flex gap-3 overflow-x-auto pb-2" data-testid="pipeline-board">
        {COLUMNS.map((stage) => (
          <PipelineColumn key={stage} stage={stage} title={STAGE_LABEL[stage] ?? stage} cards={byStage.get(stage) ?? []} back={back} />
        ))}
      </div>
    </div>
  );
}
