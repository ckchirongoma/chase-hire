import Link from "next/link";
import { ImportForm } from "@/components/ImportForm";
import { requireManager } from "@/lib/auth";
import { dateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

const REASONS: Record<string, string> = {
  invalid_phone: "Phone number unusable",
  ambiguous_date: "Date could be day/month or month/day",
  invalid_date: "Not a real date",
  epoch_date: "Placeholder date (1970)",
  conflicting_duplicate: "Same line twice with different values",
  missing_account_no: "No account number",
  missing_customer_name: "No customer name",
  unknown_customer: "No matching customer",
  invalid_email: "Email address unusable",
  unknown_status: "Status not recognised",
  missing_company: "No company name",
};

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const caller = await requireManager();
  const { run } = await searchParams;
  const { data: runs } = await caller.db.from("import_runs").select("id, kind, file_name, status, counts, error, created_at").order("created_at", { ascending: false }).limit(20);
  const selected = (runs ?? []).find((r) => r.id === run) ?? (runs ?? []).find((r) => r.status === "succeeded");
  const { data: quarantine } = selected
    ? await caller.db.from("quarantine_rows").select("row_number, reason, detail, raw").eq("import_run_id", selected.id).order("row_number").limit(1000)
    : { data: [] };

  return (
    <div className="space-y-5">
      <h1 className="h1">Import</h1>
      <p className="muted">
        Upload the Network&apos;s monthly base export as it arrives. Re-uploading the same file changes nothing. If the file&apos;s columns change, the import stops and nothing is written. Rows the
        import cannot trust are listed below for fixing at source.
      </p>
      <ImportForm />

      <section className="card overflow-x-auto">
        <h2 className="h2">Recent imports</h2>
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>File</th>
              <th>Kind</th>
              <th>Result</th>
              <th>Quarantined</th>
            </tr>
          </thead>
          <tbody>
            {(runs ?? []).map((r) => {
              const counts = (r.counts ?? {}) as Record<string, unknown>;
              return (
                <tr key={r.id} className={selected?.id === r.id ? "bg-slate-50" : ""}>
                  <td>
                    <Link className="underline" href={`/import?run=${r.id}`}>
                      {dateTime(r.created_at)}
                    </Link>
                  </td>
                  <td>{r.file_name}</td>
                  <td>{r.kind}</td>
                  <td>{r.status === "failed" ? <span className="text-red-700">Failed: {r.error}</span> : r.kind === "base" ? `${counts.lines_new ?? 0} new, ${counts.lines_updated ?? 0} changed, ${counts.lines_ported_out ?? 0} ported out` : "OK"}</td>
                  <td>{String(counts.quarantined ?? "–")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {selected && (
        <section className="card overflow-x-auto">
          <h2 className="h2">
            Quarantine report: {selected.file_name} ({(quarantine ?? []).length} rows)
          </h2>
          {(quarantine ?? []).length === 0 && <p className="muted">Nothing quarantined.</p>}
          {(quarantine ?? []).length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Reason</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {(quarantine ?? []).map((q, i) => (
                  <tr key={`${q.row_number}-${i}`}>
                    <td>{q.row_number}</td>
                    <td>{REASONS[q.reason] ?? q.reason}</td>
                    <td>{q.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
