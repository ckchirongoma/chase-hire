import Link from "next/link";
import { requireAdmin } from "@/lib/server/auth";
import { fmtDate } from "@/lib/format";
import { inChunks } from "@/lib/server/query";
import { respondToReview } from "./actions";

export const dynamic = "force-dynamic";

const STAGE: Record<string, string> = {
  reasoning: "Reasoning Assessment",
  cv: "CV",
  interview: "AI CV interview",
  quiz: "Role quiz",
  work_1: "Work assessment 1",
  work_2: "Work assessment 2",
  live: "Live stage",
  decision: "Decision",
};

type Row = {
  id: string;
  user_id: string;
  stage: string;
  message: string;
  status: string;
  response: string | null;
  created_at: string;
  responded_at: string | null;
};

/**
 * Candidates' requests for a person to review a score or decision, or for an accommodation such
 * as a typed interview (docs/12). Check here before rejecting anyone (docs/09 §10).
 */
export default async function ReviewsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; all?: string }> }) {
  const { supabase } = await requireAdmin();
  const { ok, error, all } = await searchParams;
  let q = supabase.from("review_requests").select("id, user_id, stage, message, status, response, created_at, responded_at").order("created_at");
  if (!all) q = q.eq("status", "open");
  const { data } = await q.limit(500);
  const rows = (data ?? []) as Row[];
  const ids = [...new Set(rows.map((r) => r.user_id))];
  const profiles = await inChunks<{ user_id: string; full_name: string | null; email: string | null }>(ids, (c) =>
    supabase.from("profiles").select("user_id, full_name, email").in("user_id", c),
  );
  const who = new Map(profiles.map((p) => [p.user_id, `${p.full_name || "(no name)"} · ${p.email ?? ""}`]));

  return (
    <div className="space-y-4">
      <h1 className="h1">Review requests ({rows.length}{all ? "" : " open"})</h1>
      <p className="muted">
        A candidate&apos;s right to make representations about any score or decision (POPIA s71). Accommodation requests, such
        as a typed interview for someone who can&apos;t use a microphone, arrive here too: set them on the candidate page before
        the interview starts.{" "}
        <Link href={all ? "/admin/reviews" : "/admin/reviews?all=1"} className="underline">
          {all ? "Open only" : "Show all"}
        </Link>
      </p>
      {error && <p className="error">{error}</p>}
      {ok && <p className="notice">Reply sent.</p>}
      {!rows.length && <p className="muted">No open requests.</p>}
      {rows.map((r) => (
        <article key={r.id} className="card space-y-2 text-sm" data-testid="review-request">
          <p>
            <Link href={`/admin/candidates/${r.user_id}`} className="font-medium underline">
              {who.get(r.user_id) ?? r.user_id.slice(0, 8)}
            </Link>{" "}
            · {STAGE[r.stage] ?? r.stage} · {fmtDate(r.created_at)} · <span className="badge">{r.status}</span>
          </p>
          <p className="whitespace-pre-line">{r.message}</p>
          {r.response && (
            <p className="border-l-2 border-slate-300 pl-2">
              Our reply ({fmtDate(r.responded_at)}): {r.response}
            </p>
          )}
          {r.status !== "closed" && (
            <form action={respondToReview} className="space-y-2">
              <input type="hidden" name="review_id" value={r.id} />
              <textarea name="response" required minLength={5} rows={3} className="input" placeholder="Reply to the candidate" />
              <label className="flex items-center gap-2">
                <input type="checkbox" name="close" value="1" /> Close the request after replying
              </label>
              <button className="btn">Send reply</button>
            </form>
          )}
        </article>
      ))}
    </div>
  );
}
