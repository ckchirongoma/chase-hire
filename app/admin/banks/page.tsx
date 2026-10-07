import { requireAdmin } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export default async function BanksPage() {
  const { supabase } = await requireAdmin();
  const { data: items } = await supabase.from("reasoning_items").select("*").order("family").order("tier");
  return (
    <div className="space-y-4">
      <h1 className="h1">Reasoning item bank</h1>
      <p className="muted">
        Every item is generated fresh per candidate from a seed, so there is no fixed answer key to leak. Each row is a
        template (family × tier). Item statistics need at least 40 exposures before they count.
      </p>
      <table className="table card">
        <thead><tr><th>Family</th><th>Tier</th><th>Generator</th><th>Form</th><th>Active</th><th>Exposures</th><th>p</th><th>Discrimination</th></tr></thead>
        <tbody>
          {items?.map((i) => (
            <tr key={i.id}>
              <td>{i.family}</td><td>{i.tier}</td><td>{i.generator}</td><td>{i.form}</td><td>{i.active ? "yes" : "no"}</td>
              <td>{i.exposures}</td><td>{i.difficulty_p ?? "—"}</td><td>{i.discrimination ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
