import Link from "next/link";
import { requireCaller } from "@/lib/auth";
import { dateTime, day, rands } from "@/lib/format";
import { OUTCOME_LABELS, type Outcome } from "@/lib/validation";

export const dynamic = "force-dynamic";

interface QueueRow {
  customer_id: string;
  legal_name: string;
  segment: string | null;
  lines_in_window: number;
  first_end_date: string;
  first_eligible_from: string;
  eligible_now: boolean;
  monthly_charges_zar: number;
  agent_id: string | null;
  last_outcome: Outcome | null;
  next_action_at: string | null;
  last_contact_at: string | null;
  opted_out: boolean;
  contactable: boolean;
}

function queueStatus(r: QueueRow): { label: string; tone: string } {
  if (r.opted_out) return { label: "Opted out: call only", tone: "bg-red-100 text-red-800" };
  if (r.last_outcome === "call_back" && r.next_action_at && new Date(r.next_action_at) < new Date()) return { label: "Callback overdue", tone: "bg-orange-100 text-orange-800" };
  if (r.last_outcome === "call_back") return { label: "Callback booked", tone: "bg-sky-100 text-sky-800" };
  if (r.eligible_now) return { label: "Eligible now", tone: "bg-emerald-100 text-emerald-800" };
  return { label: `Eligible from ${day(r.first_eligible_from)}`, tone: "bg-slate-100 text-slate-700" };
}

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const caller = await requireCaller();
  const { show } = await searchParams;
  const onlyEligible = show !== "all";
  let query = caller.db.from("renewal_queue").select("*").order("first_eligible_from", { ascending: true }).order("monthly_charges_zar", { ascending: false }).limit(500);
  if (onlyEligible) query = query.eq("eligible_now", true);
  const { data, error } = await query;
  const rows = (data ?? []) as QueueRow[];
  const agentNames = new Map<string, string>();
  if (caller.isManager) {
    const { data: agents } = await caller.db.from("agents").select("id, name");
    for (const a of agents ?? []) agentNames.set(a.id, a.name);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-4">
        <h1 className="h1">Renewal queue</h1>
        <span className="muted">Lines whose contract ends in the next 90 days{caller.isManager ? " (all agents)" : " (your customers)"}.</span>
      </div>
      <div className="flex gap-2 text-sm">
        <Link className={onlyEligible ? "btn" : "btn-secondary"} href="/queue">
          Eligible now
        </Link>
        <Link className={!onlyEligible ? "btn" : "btn-secondary"} href="/queue?show=all">
          Whole 90-day window
        </Link>
      </div>
      {error && <p className="error">The queue could not be loaded.</p>}
      {!error && rows.length === 0 && <p className="notice">Nothing in the queue. {caller.isManager ? "Import this month's base export, or allocate customers." : "Ask your manager to allocate customers to you."}</p>}
      {rows.length > 0 && (
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Lines</th>
                <th>First end date</th>
                <th>Monthly charges</th>
                <th>Status</th>
                <th>Last outcome</th>
                <th>Next action</th>
                {caller.isManager && <th>Agent</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = queueStatus(r);
                return (
                  <tr key={r.customer_id}>
                    <td>
                      <Link className="font-medium underline" href={`/customers/${r.customer_id}`}>
                        {r.legal_name}
                      </Link>
                      {!r.contactable && !r.opted_out && <div className="muted">No consented contact</div>}
                    </td>
                    <td>{r.lines_in_window}</td>
                    <td>{day(r.first_end_date)}</td>
                    <td>{rands(r.monthly_charges_zar)}</td>
                    <td>
                      <span className={`badge ${s.tone}`}>{s.label}</span>
                    </td>
                    <td>{r.last_outcome ? OUTCOME_LABELS[r.last_outcome] : "–"}</td>
                    <td>{dateTime(r.next_action_at)}</td>
                    {caller.isManager && <td>{r.agent_id ? (agentNames.get(r.agent_id) ?? "–") : <span className="badge bg-amber-100 text-amber-800">Unallocated</span>}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
