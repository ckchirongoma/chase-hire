import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function RolesPage() {
  const supabase = await createClient();
  const { data: roles } = await supabase
    .from("roles")
    .select("slug, title, summary, salary_min, salary_max, location_note")
    .eq("active", true)
    .order("title");

  return (
    <div className="space-y-4">
      <h1 className="h1">Open roles</h1>
      {(roles ?? []).map((r) => (
        <Link key={r.slug} href={`/roles/${r.slug}`} className="card block hover:border-slate-400">
          <h2 className="h2">{r.title}</h2>
          <p className="text-sm text-slate-700">{r.summary}</p>
          <p className="mt-2 text-sm font-medium">
            {rands(r.salary_min)}–{rands(r.salary_max)} a month + year-end profit share · {r.location_note}
          </p>
        </Link>
      ))}
      {!roles?.length && <p className="muted">No open roles right now.</p>}
    </div>
  );
}
