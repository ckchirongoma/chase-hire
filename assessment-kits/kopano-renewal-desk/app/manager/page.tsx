import Link from "next/link";
import { AllocateForm } from "@/components/AllocateForm";
import { requireManager } from "@/lib/auth";
import { dateTime, day, rands } from "@/lib/format";

export const dynamic = "force-dynamic";

interface QueueRow {
  customer_id: string;
  legal_name: string;
  first_end_date: string;
  eligible_now: boolean;
  monthly_charges_zar: number;
  agent_id: string | null;
  last_outcome: string | null;
  next_action_at: string | null;
  opted_out: boolean;
  contactable: boolean;
  has_contact: boolean;
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="card overflow-x-auto">
      <h2 className="h2">
        {title} <span className="badge bg-slate-100 text-slate-700">{count}</span>
      </h2>
      {count === 0 ? <p className="muted">None.</p> : children}
    </section>
  );
}

const CustomerLink = ({ id, name }: { id: string; name: string }) => (
  <Link className="underline" href={`/customers/${id}`}>
    {name}
  </Link>
);

export default async function ManagerPage() {
  const caller = await requireManager();
  const db = caller.db;
  const now = new Date().toISOString();
  const [queueRes, overdueRes, agentsRes, optoutsRes] = await Promise.all([
    db.from("renewal_queue").select("*").order("first_end_date").limit(2000),
    db.from("latest_interactions").select("customer_id, agent_id, next_action_at").eq("outcome", "call_back").lt("next_action_at", now).order("next_action_at").limit(500),
    db.from("agents").select("id, name, role").order("name"),
    db.from("optouts").select("id, company_name, status, match_method, match_distance, customer_id, customers(legal_name)").or("customer_id.is.null,match_method.eq.fuzzy").order("company_name"),
  ]);
  const queue = (queueRes.data ?? []) as QueueRow[];
  const agents = (agentsRes.data ?? []).filter((a) => a.role === "agent");
  const agentName = new Map((agentsRes.data ?? []).map((a) => [a.id, a.name]));
  const overdue = overdueRes.data ?? [];
  const names = new Map<string, string>();
  if (overdue.length) {
    const { data } = await db.from("customers").select("id, legal_name").in("id", overdue.map((o) => o.customer_id));
    for (const c of data ?? []) names.set(c.id, c.legal_name);
  }
  const missingNext = queue.filter((r) => r.eligible_now && !r.opted_out && (!r.last_outcome || (!r.next_action_at && !["sale", "not_interested"].includes(r.last_outcome))));
  const noContact = queue.filter((r) => !r.contactable && !r.opted_out);
  const unallocated = queue.filter((r) => !r.agent_id);
  const optouts = optoutsRes.data ?? [];

  return (
    <div className="space-y-5">
      <h1 className="h1">Exceptions</h1>
      <p className="muted">What needs a manager today. Customers listed here are in the 90-day renewal window unless stated.</p>

      <Section title="Overdue callbacks" count={overdue.length}>
        <table className="table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Was due</th>
              <th>Agent</th>
            </tr>
          </thead>
          <tbody>
            {overdue.map((o) => (
              <tr key={o.customer_id}>
                <td>
                  <CustomerLink id={o.customer_id} name={names.get(o.customer_id) ?? o.customer_id} />
                </td>
                <td>{dateTime(o.next_action_at)}</td>
                <td>{agentName.get(o.agent_id) ?? "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Eligible now, no next action" count={missingNext.length}>
        <table className="table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>First end date</th>
              <th>Monthly charges</th>
              <th>Agent</th>
            </tr>
          </thead>
          <tbody>
            {missingNext.slice(0, 200).map((r) => (
              <tr key={r.customer_id}>
                <td>
                  <CustomerLink id={r.customer_id} name={r.legal_name} />
                </td>
                <td>{day(r.first_end_date)}</td>
                <td>{rands(r.monthly_charges_zar)}</td>
                <td>{r.agent_id ? (agentName.get(r.agent_id) ?? "–") : "Unallocated"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="No consented contact point" count={noContact.length}>
        <table className="table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>First end date</th>
              <th>Any contact on file</th>
            </tr>
          </thead>
          <tbody>
            {noContact.slice(0, 200).map((r) => (
              <tr key={r.customer_id}>
                <td>
                  <CustomerLink id={r.customer_id} name={r.legal_name} />
                </td>
                <td>{day(r.first_end_date)}</td>
                <td>{r.has_contact ? "Yes, without consent" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Unallocated customers in the window" count={unallocated.length}>
        <table className="table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>First end date</th>
              <th>Allocate to</th>
            </tr>
          </thead>
          <tbody>
            {unallocated.slice(0, 200).map((r) => (
              <tr key={r.customer_id}>
                <td>
                  <CustomerLink id={r.customer_id} name={r.legal_name} />
                </td>
                <td>{day(r.first_end_date)}</td>
                <td>
                  <AllocateForm agents={agents} customerId={r.customer_id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Opt-out entries to check (unmatched or near matches)" count={optouts.length}>
        <table className="table">
          <thead>
            <tr>
              <th>Listed as</th>
              <th>Status</th>
              <th>Matched to</th>
            </tr>
          </thead>
          <tbody>
            {optouts.map((o) => {
              const matched = (o.customers as unknown as { legal_name: string } | null)?.legal_name;
              return (
                <tr key={o.id}>
                  <td>{o.company_name}</td>
                  <td>{o.status === "legal_review" ? "Under legal review" : "Opted out"}</td>
                  <td>{o.customer_id ? <CustomerLink id={o.customer_id} name={`${matched ?? "customer"} (near match, ${o.match_distance} edits)`} /> : "No customer found"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
