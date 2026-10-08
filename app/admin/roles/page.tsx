import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";
import { rands } from "@/lib/format";

export const dynamic = "force-dynamic";

const RoleForm = z.object({
  id: z.uuid(),
  title: z.string().trim().min(3).max(200),
  summary: z.string().trim().min(10).max(1000),
  spec_md: z.string().trim().max(10000),
  jd_md: z.string().trim().max(20000),
  salary_min: z.coerce.number().int().positive(),
  salary_max: z.coerce.number().int().positive(),
  location_note: z.string().trim().max(300),
  reasoning_min_stars: z.coerce.number().int().min(1).max(6),
  quiz_flag_pct: z.coerce.number().int().min(0).max(100),
  active: z.literal("on").optional(),
});

async function saveRole(formData: FormData) {
  "use server";
  const { supabase } = await requireAdmin();
  const parsed = RoleForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`/admin/roles?error=${encodeURIComponent(parsed.error.issues[0].message)}`);
  const { id, active, ...rest } = parsed.data;
  const { error } = await supabase.from("roles").update({ ...rest, active: active === "on" }).eq("id", id);
  if (error) redirect(`/admin/roles?error=${encodeURIComponent(error.message)}`);
  redirect("/admin/roles?ok=1");
}

export default async function AdminRoles({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { supabase } = await requireAdmin();
  const { error, ok } = await searchParams;
  const { data: roles } = await supabase.from("roles").select("*").order("title");

  return (
    <div className="space-y-4">
      <h1 className="h1">Roles</h1>
      {error && <p className="error">{error}</p>}
      {ok && <p className="notice">Saved.</p>}
      {roles?.map((r) => (
        <form key={r.id} action={saveRole} className="card grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="id" value={r.id} />
          <h2 className="h2 sm:col-span-2">{r.title} <span className="muted">/{r.slug} · {rands(r.salary_min)}–{rands(r.salary_max)}</span></h2>
          <div className="sm:col-span-2"><label className="label">Title</label><input name="title" className="input" defaultValue={r.title} /></div>
          <div className="sm:col-span-2"><label className="label">Summary</label><textarea name="summary" className="input" rows={2} defaultValue={r.summary} /></div>
          <div className="sm:col-span-2"><label className="label">Role spec (short and factual: the AI interviewer reads it to match CV claims to the role)</label><textarea name="spec_md" className="input" rows={4} defaultValue={r.spec_md} /></div>
          <div className="sm:col-span-2">
            <label className="label">Job description (what candidates read on the role page; ## headings, - bullets, 1. steps, **bold**)</label>
            <textarea name="jd_md" className="input font-mono text-xs" rows={18} defaultValue={r.jd_md} />
            <a href={`/roles/${r.slug}`} target="_blank" className="text-sm underline">Preview the role page</a>
          </div>
          <div><label className="label">Salary min (R/month)</label><input name="salary_min" type="number" className="input" defaultValue={r.salary_min} /></div>
          <div><label className="label">Salary max (R/month)</label><input name="salary_max" type="number" className="input" defaultValue={r.salary_max} /></div>
          <div className="sm:col-span-2"><label className="label">Location note</label><input name="location_note" className="input" defaultValue={r.location_note} /></div>
          <div><label className="label">Reasoning hurdle (stars; below = queued for review, never rejected)</label><input name="reasoning_min_stars" type="number" min={1} max={6} className="input" defaultValue={r.reasoning_min_stars} /></div>
          <div><label className="label">Quiz flag line (%)</label><input name="quiz_flag_pct" type="number" min={0} max={100} className="input" defaultValue={r.quiz_flag_pct} /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={r.active} /> Active (visible to candidates)</label>
          <div className="sm:col-span-2"><button className="btn">Save</button></div>
        </form>
      ))}
    </div>
  );
}
