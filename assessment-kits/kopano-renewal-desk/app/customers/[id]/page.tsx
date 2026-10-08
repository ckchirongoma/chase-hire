import Link from "next/link";
import { notFound } from "next/navigation";
import { ConsentButtons } from "@/components/ConsentButtons";
import { MessageForm, type TemplateOption } from "@/components/MessageForm";
import { OutcomeForm } from "@/components/OutcomeForm";
import { SummaryPanel } from "@/components/SummaryPanel";
import { requireCaller } from "@/lib/auth";
import { CONSENT_LABELS, dateTime, day, rands } from "@/lib/format";
import { deriveContractStatus } from "@/lib/import/normalise";
import { BLOCK_MESSAGES, eligibleContacts, type ContactPointLite } from "@/lib/messaging";
import { OUTCOME_LABELS, type Outcome } from "@/lib/validation";

export const dynamic = "force-dynamic";

interface LineRow {
  id: string;
  account_id: string;
  msisdn_e164: string;
  number_type: string;
  priceplan: string | null;
  priceplan_name: string | null;
  contract_end_date: string | null;
  contract_status: string;
  monthly_charge_zar: number | null;
  device: string | null;
  active: boolean;
  ported_out_at: string | null;
}

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const caller = await requireCaller();
  const db = caller.db;
  const { data: customer } = await db.from("customers").select("id, legal_name, reg_no, segment").eq("id", id).maybeSingle();
  if (!customer) notFound();

  const { data: accounts } = await db.from("accounts").select("id, account_no, dealer_code").eq("customer_id", id).order("account_no");
  const accountIds = (accounts ?? []).map((a) => a.id);
  const [linesRes, contactsRes, interactionsRes, templatesRes, queueRes, optedOutRes, optoutRes, agentsRes] = await Promise.all([
    accountIds.length ? db.from("lines").select("*").in("account_id", accountIds).order("contract_end_date", { ascending: true }) : Promise.resolve({ data: [] }),
    db.from("contact_points").select("id, type, value, person_name, role, consent_status, verified_at, consent_note, source").eq("customer_id", id).order("type"),
    db.from("interactions").select("id, agent_id, outcome, next_action_at, notes, created_at").eq("customer_id", id).order("created_at", { ascending: false }),
    db.from("templates").select("id, name, category, body").eq("approved", true).order("name"),
    db.from("message_queue").select("id, template_id, channel, status, created_at").eq("customer_id", id).order("created_at", { ascending: false }).limit(10),
    db.rpc("customer_opted_out", { p_customer_id: id }),
    db.from("optouts").select("company_name, status, match_method").eq("customer_id", id),
    db.from("agents").select("id, name"),
  ]);
  const lines = (linesRes.data ?? []) as LineRow[];
  const contacts = contactsRes.data ?? [];
  const interactions = interactionsRes.data ?? [];
  const templates = (templatesRes.data ?? []) as TemplateOption[];
  const optedOut = optedOutRes.data === true;
  const agentName = new Map((agentsRes.data ?? []).map((a) => [a.id, a.name]));
  const accountNo = new Map((accounts ?? []).map((a) => [a.id, a.account_no]));
  const messageable = eligibleContacts(contacts as ContactPointLite[], "utility");
  const blocked = optedOut ? BLOCK_MESSAGES.opted_out : messageable.length === 0 ? BLOCK_MESSAGES.no_consented_contact : null;

  return (
    <div className="space-y-5">
      <div>
        <Link className="muted underline" href="/queue">
          ← Queue
        </Link>
        <h1 className="h1 mt-2">{customer.legal_name}</h1>
        <p className="muted">
          Reg no {customer.reg_no ?? "unknown"} · {customer.segment ?? "segment unknown"} · accounts {(accounts ?? []).map((a) => a.account_no).join(", ") || "–"}
        </p>
      </div>
      {optedOut && (
        <p className="error">
          On Legal&apos;s opt-out list{optoutRes.data?.[0] ? ` as "${optoutRes.data[0].company_name}" (${optoutRes.data[0].status === "legal_review" ? "under legal review" : "opted out"})` : ""}. Do not message or market to this customer.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <section className="card lg:col-span-2">
          <h2 className="h2">Lines</h2>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Account</th>
                  <th>Plan</th>
                  <th>Contract end</th>
                  <th>Status</th>
                  <th>Monthly</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className={l.active ? "" : "text-slate-400"}>
                    <td>
                      {l.msisdn_e164}
                      {l.number_type === "landline" && <span className="badge ml-1 bg-slate-100 text-slate-600">landline</span>}
                    </td>
                    <td>{accountNo.get(l.account_id)}</td>
                    <td>{l.priceplan_name ?? l.priceplan ?? "–"}</td>
                    <td>{day(l.contract_end_date)}</td>
                    {/* BR-E3: derived from the end date when shown, so it is never stale between imports. */}
                    <td>{l.active ? deriveContractStatus(l.contract_end_date) : `Ported out ${day(l.ported_out_at)}`}</td>
                    <td>{rands(l.monthly_charge_zar)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <h2 className="h2">Log outcome</h2>
          <OutcomeForm customerId={customer.id} />
        </section>

        <section className="card lg:col-span-2">
          <h2 className="h2">Contact points</h2>
          {contacts.length === 0 && <p className="notice">No contact details yet. Capture the decision maker&apos;s number and consent on the next call.</p>}
          {contacts.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Value</th>
                  <th>Person</th>
                  <th>Consent</th>
                  <th>Record consent</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id}>
                    <td>{c.type}</td>
                    <td>{c.value}</td>
                    <td>
                      {c.person_name ?? "–"} <span className="muted">({c.role.replace("_", " ")})</span>
                    </td>
                    <td>
                      {CONSENT_LABELS[c.consent_status] ?? c.consent_status}
                      {c.verified_at && <div className="muted">confirmed {day(c.verified_at)}</div>}
                      {c.consent_note && <div className="muted">note: {c.consent_note}</div>}
                    </td>
                    <td>{c.type !== "landline" && <ConsentButtons contactPointId={c.id} status={c.consent_status} canLift={caller.isManager} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <h2 className="h2">Message</h2>
          <MessageForm customerId={customer.id} templates={templates} blocked={blocked} />
          {(queueRes.data ?? []).length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {(queueRes.data ?? []).map((m) => (
                <li key={m.id} className="muted">
                  {m.status} via {m.channel} · {dateTime(m.created_at)}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card lg:col-span-2">
          <h2 className="h2">History</h2>
          {interactions.length === 0 && <p className="muted">No calls logged yet.</p>}
          <ul className="space-y-3">
            {interactions.map((i) => (
              <li key={i.id} className="border-b border-slate-100 pb-2 text-sm">
                <span className="font-medium">{OUTCOME_LABELS[i.outcome as Outcome] ?? i.outcome}</span> · {dateTime(i.created_at)} · {i.agent_id === caller.userId ? "you" : (agentName.get(i.agent_id) ?? "another agent")}
                {i.next_action_at && <span> · next action {dateTime(i.next_action_at)}</span>}
                {i.notes && <p className="mt-1 whitespace-pre-wrap text-slate-700">{i.notes}</p>}
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2 className="h2">Before the call</h2>
          <SummaryPanel customerId={customer.id} />
        </section>
      </div>
    </div>
  );
}
