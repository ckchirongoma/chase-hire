import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";
import { fmtDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const Resolve = z.object({
  flag_id: z.uuid(),
  status: z.enum(["merged", "not_duplicate", "blocked"]),
  note: z.string().trim().max(1000).optional(),
});

async function resolve(formData: FormData) {
  "use server";
  const { supabase, user } = await requireAdmin();
  const parsed = Resolve.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/admin/dedupe?error=Invalid input");
  const { error } = await supabase
    .from("dedupe_flags")
    .update({ status: parsed.data.status, note: parsed.data.note || null, resolved_by: user.id, resolved_at: new Date().toISOString() })
    .eq("id", parsed.data.flag_id);
  if (error) redirect(`/admin/dedupe?error=${encodeURIComponent(error.message)}`);
  redirect("/admin/dedupe");
}

type Side = { user_id: string; email: string | null; full_name: string | null; phone_e164: string | null };

export default async function DedupePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { supabase } = await requireAdmin();
  const { error } = await searchParams;
  const { data: flags } = await supabase.from("dedupe_flags").select("*").eq("status", "open").order("created_at", { ascending: false }).limit(200);
  const ids = [...new Set((flags ?? []).flatMap((f) => [f.user_id, f.matched_user_id]))];
  const { data: people } = ids.length
    ? await supabase.from("profiles").select("user_id, email, full_name, phone_e164").in("user_id", ids)
    : { data: [] };
  const byId = new Map((people as Side[]).map((p) => [p.user_id, p]));

  const person = (uid: string) => {
    const p = byId.get(uid);
    return (
      <div>
        <Link href={`/admin/candidates/${uid}`} className="font-medium underline">{p?.full_name || "(no name)"}</Link>
        <div className="muted">{p?.email}</div>
        <div className="muted">{p?.phone_e164}</div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <h1 className="h1">Dedupe queue ({flags?.length ?? 0} open)</h1>
      <p className="muted">
        A flag never blocks anyone automatically. &quot;Blocked&quot; only records your judgement; to stop an application, record a reject decision with a reason on the candidate page.
      </p>
      {error && <p className="error">{error}</p>}
      {flags?.map((f) => (
        <div key={f.id} className="card grid gap-4 sm:grid-cols-[1fr_1fr_2fr]">
          {person(f.user_id)}
          {person(f.matched_user_id)}
          <div className="space-y-2 text-sm">
            <p>
              <span className={f.kind === "semantic_review" ? "badge-warn" : "badge-bad"}>{f.kind}</span>{" "}
              {f.similarity != null && <>similarity {f.similarity}</>} {f.matched_fields?.length ? `· ${f.matched_fields.join(", ")}` : ""}
            </p>
            <p className="muted">{fmtDate(f.created_at)}</p>
            <form action={resolve} className="flex flex-wrap gap-2">
              <input type="hidden" name="flag_id" value={f.id} />
              <select name="status" className="input w-40">
                <option value="not_duplicate">Not a duplicate</option>
                <option value="merged">Same person (merged)</option>
                <option value="blocked">Blocked</option>
              </select>
              <input name="note" className="input flex-1" placeholder="Note (optional)" />
              <button className="btn">Resolve</button>
            </form>
          </div>
        </div>
      ))}
    </div>
  );
}
