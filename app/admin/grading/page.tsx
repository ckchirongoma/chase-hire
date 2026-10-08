import Link from "next/link";
import { requireAdmin } from "@/lib/server/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { inChunks } from "@/lib/server/query";
import { fmtDate, STAGE_LABEL } from "@/lib/format";
import { overrideGrade } from "./actions";

export const dynamic = "force-dynamic";

type Row = {
  subject_type: "interview" | "submission";
  subject_id: string;
  criterion_key: string;
  median_score: number | null;
  spread: number | null;
  review_reason: string | null;
  updated_at: string;
};
type Owner = { applicationId: string; userId: string; roleTitle: string; stage: string };

/**
 * Queue of AI-graded criteria that need a person (docs/09 §7): open the evidence, then score
 * with a reason. Nothing here advances or rejects anyone.
 */
export default async function GradingQueuePage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; blind?: string }> }) {
  await requireAdmin();
  const { ok, error, blind } = await searchParams;
  const admin = createAdminClient();
  const { data } = await admin
    .from("grade_summaries")
    .select("subject_type, subject_id, criterion_key, median_score, spread, review_reason, updated_at")
    .eq("needs_human_review", true)
    .is("human_score", null)
    .in("subject_type", ["interview", "submission"])
    .not("criterion_key", "like", "%.%")
    .order("updated_at")
    .limit(500);
  const rows = (data ?? []) as Row[];

  // Subject → application → candidate.
  const owners = new Map<string, Owner>();
  const sessionIds = rows.filter((r) => r.subject_type === "interview").map((r) => r.subject_id);
  const submissionIds = rows.filter((r) => r.subject_type === "submission").map((r) => r.subject_id);
  if (sessionIds.length) {
    const s = await inChunks(sessionIds, (c) =>
      admin
        .from("interview_sessions")
        .select("id, applications(id, user_id, stage, roles(title))")
        .in("id", c)
        .returns<{ id: string; applications: { id: string; user_id: string; stage: string; roles: { title: string } | null } | null }[]>(),
    );
    for (const x of s)
      if (x.applications) owners.set(x.id, { applicationId: x.applications.id, userId: x.applications.user_id, roleTitle: x.applications.roles?.title ?? "", stage: "interview" });
  }
  if (submissionIds.length) {
    const s = await inChunks(submissionIds, (c) =>
      admin
        .from("submissions")
        .select("id, stage_key, work_attempts(applications(id, user_id, roles(title)))")
        .in("id", c)
        .returns<{ id: string; stage_key: string; work_attempts: { applications: { id: string; user_id: string; roles: { title: string } | null } | null } | null }[]>(),
    );
    for (const x of s) {
      const a = x.work_attempts?.applications;
      if (a) owners.set(x.id, { applicationId: a.id, userId: a.user_id, roleTitle: a.roles?.title ?? "", stage: x.stage_key });
    }
  }
  const userIds = [...new Set([...owners.values()].map((o) => o.userId))];
  const profiles = await inChunks<{ user_id: string; full_name: string | null }>(userIds, (c) => admin.from("profiles").select("user_id, full_name").in("user_id", c));
  const nameOf = new Map(profiles.map((p) => [p.user_id, p.full_name || "(no name)"]));
  const back = `/admin/grading${blind ? "?blind=1" : ""}`;

  return (
    <div className="space-y-4">
      <h1 className="h1">Grading queue ({rows.length})</h1>
      <p className="muted">
        Criteria the AI graders could not settle: the three samples disagreed by 2 or more points, a sample had no evidence, the
        candidate gave no answers, or the criterion is human-scored until calibrated. Read the evidence on the candidate page,
        then score 1–5 with a reason. Your score replaces the AI median.{" "}
        <Link href={blind ? "/admin/grading" : "/admin/grading?blind=1"} className="underline">
          {blind ? "Show names" : "Blind review (hide names)"}
        </Link>
      </p>
      {error && <p className="error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}
      {!rows.length && <p className="muted">Nothing needs review.</p>}
      {rows.map((r) => {
        const o = owners.get(r.subject_id);
        return (
          <article key={`${r.subject_id}:${r.criterion_key}`} className="card space-y-2 text-sm" data-testid="grading-item">
            <p>
              <strong>{r.criterion_key}</strong> · {STAGE_LABEL[o?.stage ?? ""] ?? o?.stage ?? r.subject_type} · {o?.roleTitle}
              {o && (
                <>
                  {" · "}
                  <Link href={`/admin/candidates/${o.userId}`} className="underline">
                    {blind ? `Candidate ${o.applicationId.slice(0, 8)}` : nameOf.get(o.userId)} (evidence)
                  </Link>
                </>
              )}
            </p>
            <p className="muted">
              AI median {r.median_score ?? "—"} · spread {r.spread ?? "—"} · {r.review_reason ?? "flagged"} · {fmtDate(r.updated_at)}
            </p>
            <form action={overrideGrade} className="flex flex-wrap items-start gap-2">
              <input type="hidden" name="subject_type" value={r.subject_type} />
              <input type="hidden" name="subject_id" value={r.subject_id} />
              <input type="hidden" name="criterion_key" value={r.criterion_key} />
              <input type="hidden" name="back" value={back} />
              <select name="score" className="input w-24" defaultValue="" required aria-label={`Score for ${r.criterion_key}`}>
                <option value="" disabled>
                  Score
                </option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <textarea name="reason" required minLength={20} rows={2} className="input flex-1" placeholder="Reason, quoting the evidence (min 20 characters)" />
              <button className="btn">Save score</button>
            </form>
          </article>
        );
      })}
    </div>
  );
}
