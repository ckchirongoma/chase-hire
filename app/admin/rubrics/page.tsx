import { requireAdmin } from "@/lib/server/auth";
import { fmtDate } from "@/lib/format";
import { parseBaseline } from "@/lib/grading/baseline";
import GenerateBaselineButton from "./generate-baseline-button";

export const dynamic = "force-dynamic";

type Criterion = { key: string; weight?: number; subcriteria?: { key: string; baseline?: string }[]; baseline?: string };
type RubricRow = {
  id: string;
  key: string;
  version: number;
  title: string;
  criteria: Criterion[];
  generic_baseline: string | null;
  active: boolean;
  created_at: string;
};

/**
 * Admin: rubric versions with their criteria count, weight sum and generic baseline status.
 * Changing a rubric, prompt or model means re-running the gold set before going live.
 */
export default async function AdminRubrics() {
  const { supabase } = await requireAdmin();
  const { data } = await supabase
    .from("rubrics")
    .select("id, key, version, title, criteria, generic_baseline, active, created_at")
    .order("key")
    .order("version", { ascending: false });
  const rubrics = (data ?? []) as RubricRow[];

  return (
    <div className="space-y-4">
      <h1 className="h1">Rubrics</h1>
      <p className="muted">
        Scores from these rubrics are advisory: they sort and flag, a person decides. Regenerating a baseline or changing a rubric needs a gold-set re-run before
        it goes live.
      </p>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Rubric</th>
              <th>Version</th>
              <th>Criteria</th>
              <th>Weights</th>
              <th>Generic baseline</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rubrics.map((r) => {
              const criteria = Array.isArray(r.criteria) ? r.criteria : [];
              const subs = criteria.reduce((s, c) => s + (c.subcriteria?.length ?? 0), 0);
              const weights = criteria.reduce((s, c) => s + Number(c.weight ?? 0), 0);
              const baseline = parseBaseline(r.generic_baseline);
              const uses = (want?: string) => criteria.some((c) => (want ? c.baseline === want : !!c.baseline) || c.subcriteria?.some((s) => (want ? s.baseline === want : !!s.baseline)));
              return (
                <tr key={r.id}>
                  <td>
                    <p className="font-medium">{r.title}</p>
                    <p className="muted">
                      {r.key} {r.active ? <span className="badge">active</span> : <span className="badge-warn">inactive</span>}
                    </p>
                  </td>
                  <td>v{r.version}</td>
                  <td>
                    {criteria.length}
                    {subs > 0 && <span className="muted"> (+{subs} sub)</span>}
                  </td>
                  <td>{weights === 100 || r.key === "interview" ? weights : <span className="badge-bad">{weights}</span>}</td>
                  <td>
                    {baseline ? (
                      <details>
                        <summary className="cursor-pointer underline">
                          present{baseline.meta.prompt_version ? ` · ${baseline.meta.prompt_version}` : ""}
                          {baseline.meta.generated_at ? ` · ${fmtDate(baseline.meta.generated_at)}` : ""}
                        </summary>
                        <p className="mt-2 whitespace-pre-line text-xs text-slate-700">{baseline.answer}</p>
                        {baseline.meta.model && <p className="muted text-xs">Model {baseline.meta.model}</p>}
                      </details>
                    ) : uses("required") ? (
                      <span className="badge-warn">missing: criteria that need it are flagged for review</span>
                    ) : uses() ? (
                      <span className="muted">missing (optional for this rubric)</span>
                    ) : (
                      <span className="muted">none</span>
                    )}
                  </td>
                  <td>{r.key !== "interview" && <GenerateBaselineButton rubricKey={r.key} version={r.version} hasBaseline={!!baseline} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
