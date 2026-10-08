import Link from "next/link";
import { requireUser } from "@/lib/server/auth";
import { fmtDate } from "@/lib/format";
import { deleteDemographics, saveDemographics } from "./actions";
import { DEMOGRAPHICS_NOTICE, DEMOGRAPHICS_NOTICE_VERSION, DISABILITY, GENDERS, POPULATION_GROUPS } from "./notice";

export const dynamic = "force-dynamic";

type Row = { population_group: string | null; gender: string | null; disability: string | null; updated_at: string; notice_version: string | null };

function Choice({ name, label, options, current }: { name: string; label: string; options: readonly { value: string; label: string }[]; current: string | null }) {
  return (
    <fieldset className="space-y-1">
      <legend className="label">{label}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <label className="flex items-center gap-1">
          <input type="radio" name={name} value="" defaultChecked={!current} /> No answer
        </label>
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-1">
            <input type="radio" name={name} value={o.value} defaultChecked={current === o.value} /> {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Optional demographics on a separate, voluntary consent (docs/12 §1, docs/09 §9). Stored apart
 * from assessment data, readable only by the candidate (RLS), used only in aggregate fairness
 * checks, never shown to graders or raters and never used in decisions.
 */
export default async function DemographicsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { supabase, user } = await requireUser("/me/demographics");
  const { ok, error } = await searchParams;
  const { data } = await supabase
    .from("demographics")
    .select("population_group, gender, disability, updated_at, notice_version")
    .eq("user_id", user.id)
    .maybeSingle<Row>();

  return (
    <div className="space-y-6">
      <h1 className="h1">Optional: help us check our assessments are fair</h1>

      <article className="card space-y-3">
        <p className="muted">Separate consent, version {DEMOGRAPHICS_NOTICE_VERSION}</p>
        {DEMOGRAPHICS_NOTICE.map((s) => (
          <section key={s.title}>
            <h2 className="font-semibold">{s.title}</h2>
            <p className="mt-1 text-sm text-slate-700">{s.body}</p>
          </section>
        ))}
      </article>

      {error && <p className="error">{error}</p>}
      {ok === "saved" && <p className="notice">Saved. Thank you.</p>}
      {ok === "deleted" && <p className="notice">Deleted. We no longer hold any of these answers.</p>}

      <form action={saveDemographics} className="card space-y-4">
        <Choice name="population_group" label="Population group" options={POPULATION_GROUPS} current={data?.population_group ?? null} />
        <Choice name="gender" label="Gender" options={GENDERS} current={data?.gender ?? null} />
        <Choice name="disability" label="Do you have a disability?" options={DISABILITY} current={data?.disability ?? null} />
        <label className="flex gap-2 text-sm">
          <input type="checkbox" name="consent" required />
          I agree that Chase Agents may keep these answers, separately from my assessment results, only to check that its
          assessments are fair to every group, as explained above.
        </label>
        <button className="btn">{data ? "Update my answers" : "Save my answers"}</button>
      </form>

      {data && (
        <section className="card space-y-2 text-sm">
          <p>
            Last saved {fmtDate(data.updated_at)}
            {data.notice_version ? ` (consent version ${data.notice_version})` : ""}.
          </p>
          <form action={deleteDemographics}>
            <button className="btn-secondary">Delete my answers</button>
          </form>
        </section>
      )}

      <p className="text-sm">
        <Link href="/me/results" className="underline">Back to my results</Link>
      </p>
    </div>
  );
}
