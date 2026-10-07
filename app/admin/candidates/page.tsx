import Link from "next/link";
import { requireAdmin } from "@/lib/server/auth";
import { fmtDate, STATUS_LABEL } from "@/lib/format";

type Row = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  signed_up_at: string;
  consented_at: string | null;
  cv_status: string | null;
  cv_injection_flags: string[] | null;
  raw_score: number | null;
  percentile: number | null;
  stars: number | null;
  open_dedupe_flags: number;
  signal_count: number;
  open_review_requests: number;
  applications: { id: string; role: string; stage: string; status: string; below_hurdle: boolean }[];
  is_admin: boolean;
};

export default async function CandidatesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; flagged?: string; role?: string; sort?: string }>;
}) {
  const { supabase } = await requireAdmin();
  const { q, flagged, role, sort } = await searchParams;

  let query = supabase.from("admin_candidates").select("*").eq("is_admin", false);
  if (q) query = query.or(`email.ilike.%${q.replace(/[%,()"]/g, "")}%,full_name.ilike.%${q.replace(/[%,()"]/g, "")}%`);
  query = sort === "stars"
    ? query.order("percentile", { ascending: false, nullsFirst: false })
    : query.order("signed_up_at", { ascending: false });
  const { data, error } = await query.limit(1000);

  let rows = (data ?? []) as Row[];
  if (role) rows = rows.filter((r) => r.applications.some((a) => a.role === role));
  const flagsOf = (r: Row) => {
    const f: string[] = [];
    if (r.open_dedupe_flags > 0) f.push(`${r.open_dedupe_flags} dedupe`);
    if (r.applications.some((a) => a.below_hurdle && a.status === "awaiting_review")) f.push("below hurdle");
    if (r.cv_injection_flags?.includes("prompt_injection")) f.push("CV injection");
    else if (r.cv_injection_flags?.length) f.push("CV hidden text");
    if (r.cv_status === "failed") f.push("CV unreadable");
    if (r.open_review_requests > 0) f.push("review requested");
    return f;
  };
  if (flagged) rows = rows.filter((r) => flagsOf(r).length > 0);

  return (
    <div className="space-y-4">
      <h1 className="h1">Candidates ({rows.length})</h1>
      <form className="flex flex-wrap gap-2 text-sm">
        <input name="q" defaultValue={q} placeholder="Search name or email" className="input w-64" />
        <select name="role" defaultValue={role ?? ""} className="input w-48">
          <option value="">All roles</option>
          <option value="business-analyst">Business Analyst</option>
          <option value="software-engineer">Software Engineer</option>
        </select>
        <select name="sort" defaultValue={sort ?? ""} className="input w-44">
          <option value="">Newest first</option>
          <option value="stars">Highest reasoning first</option>
        </select>
        <label className="flex items-center gap-1">
          <input type="checkbox" name="flagged" value="1" defaultChecked={!!flagged} /> Flagged only
        </label>
        <button className="btn-secondary">Filter</button>
      </form>
      {error && <p className="error">{error.message}</p>}
      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead>
            <tr>
              <th>Candidate</th><th>Signed up</th><th>Consent</th><th>CV</th><th>Reasoning</th>
              <th>Applications</th><th>Signals</th><th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.user_id}>
                <td>
                  <Link href={`/admin/candidates/${r.user_id}`} className="font-medium underline">
                    {r.full_name || "(no name)"}
                  </Link>
                  <div className="muted">{r.email}</div>
                </td>
                <td>{fmtDate(r.signed_up_at)}</td>
                <td>{r.consented_at ? "Yes" : <span className="badge-warn">No</span>}</td>
                <td>{r.cv_status ?? "—"}</td>
                <td>
                  {r.stars != null ? (
                    <>
                      <span className="text-amber-500">{"★".repeat(r.stars)}</span>
                      <div className="muted">{r.raw_score}/30 · P{Math.round(Number(r.percentile))}</div>
                    </>
                  ) : "—"}
                </td>
                <td>
                  {r.applications.map((a) => (
                    <div key={a.id} className="whitespace-nowrap">
                      {a.role === "business-analyst" ? "BA" : "SWE"}: {STATUS_LABEL[a.status]}
                    </div>
                  ))}
                </td>
                <td>{r.signal_count}</td>
                <td className="space-x-1">
                  {flagsOf(r).map((f) => (
                    <span key={f} className={f.includes("dedupe") || f.includes("injection") ? "badge-bad" : "badge-warn"}>{f}</span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
