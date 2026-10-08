import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";
import { parseGoogleDocUrl, parseMaterials } from "@/lib/work/gdoc";
import { gdocField, isStageKey } from "@/lib/work/stages";

export const dynamic = "force-dynamic";

const optionalHttps = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => !v || /^https:\/\//.test(v), "Links must start with https://");

const MaterialsForm = z.object({
  id: z.uuid(),
  instructions_url: optionalHttps,
  template_url: z
    .string()
    .trim()
    .max(2048)
    .refine((v) => !v || parseGoogleDocUrl(v) !== null, "The template must be a Google Docs link (https://docs.google.com/document/d/…)"),
});

async function saveMaterials(formData: FormData) {
  "use server";
  const { supabase } = await requireAdmin();
  const parsed = MaterialsForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`/admin/stages?error=${encodeURIComponent(parsed.error.issues[0].message)}`);
  const { id, instructions_url, template_url } = parsed.data;
  const materials = {
    ...(instructions_url ? { instructions_url } : {}),
    ...(template_url ? { template_url: parseGoogleDocUrl(template_url)!.url } : {}),
  };
  const { error } = await supabase.from("work_stages").update({ materials }).eq("id", id);
  if (error) redirect(`/admin/stages?error=${encodeURIComponent(error.message)}`);
  redirect("/admin/stages?ok=1");
}

/**
 * Work stages: the Google Doc links candidates get (instructions and the answer template they
 * copy). A stage answered in a template copy can't be started until its template link is set.
 */
export default async function AdminStages({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { supabase } = await requireAdmin();
  const { error, ok } = await searchParams;
  const { data: stages } = await supabase
    .from("work_stages")
    .select("id, key, title, role_slug, intended_effort, work_window, materials, active")
    .order("key");

  return (
    <div className="space-y-4">
      <h1 className="h1">Work stages</h1>
      <p className="muted">
        For stages answered in a Google Doc: upload the instructions and the answer template to Google Drive (the Word files in{" "}
        <code>assessment-kits/ba-docs/</code> become Google Docs when you open them with Google Docs), set both to “Anyone with the
        link → Viewer”, and paste the links here. Candidates get a “Make a copy” button for the template, and a stage can&apos;t start
        until its template link is set. Keep the template&apos;s first line: it&apos;s how we check a submission is a copy.
      </p>
      {error && <p className="error">{error}</p>}
      {ok && <p className="notice">Saved.</p>}
      {(stages ?? []).map((st) => {
        const m = parseMaterials(st.materials);
        const raw = (st.materials ?? {}) as Record<string, string>;
        const needsDoc = isStageKey(st.key) && !!gdocField(st.key);
        return (
          <form key={st.id} action={saveMaterials} className="card space-y-3">
            <input type="hidden" name="id" value={st.id} />
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="h2 mb-0">{st.title}</h2>
              <span className="muted">
                {st.key} · {st.intended_effort} · window {String(st.work_window)}
              </span>
            </div>
            {needsDoc ? (
              m.templateCopyUrl ? (
                <p className="text-sm">
                  Candidates get:{" "}
                  <a href={m.templateCopyUrl} target="_blank" rel="noopener noreferrer" className="underline">
                    Make a copy of the template
                  </a>
                </p>
              ) : (
                <p className="notice">No template link yet: candidates can&apos;t start this stage until you add one.</p>
              )
            ) : (
              <p className="muted">This stage takes uploads and links, not a Google Doc. Links here are optional extras.</p>
            )}
            <div>
              <label className="label" htmlFor={`i-${st.id}`}>Instructions (Google Doc or any https link)</label>
              <input id={`i-${st.id}`} name="instructions_url" className="input" defaultValue={raw.instructions_url ?? ""} placeholder="https://docs.google.com/document/d/…" />
            </div>
            <div>
              <label className="label" htmlFor={`t-${st.id}`}>Answer template (Google Doc)</label>
              <input id={`t-${st.id}`} name="template_url" className="input" defaultValue={raw.template_url ?? ""} placeholder="https://docs.google.com/document/d/…" />
            </div>
            <button className="btn">Save</button>
          </form>
        );
      })}
    </div>
  );
}
