import { addDays, addMonths, iso } from "./dates";
import type { BundleA } from "./bundle-a";
import { companyEmail, makeLandline, makeMobile, makePerson, personEmail, toE164 } from "./names";
import { createSynthRng } from "./rng";

/**
 * Bundle B (BA Part 2): the "fixed" Kopano data (kopano_clean_<version>) as CSVs and a Supabase
 * seed.sql, plus the Solution Brief (docs/06). Built from bundle A's population so the BA sees
 * the same customers, now resolved, normalised and with consent-tracked contact points.
 * Contactable share (≥1 verified, consented contact point) is about 45%: below the brief's
 * 60% gate on purpose, so the exceptions view has work to show.
 */

export const SOLUTION_BRIEF_MD = `# Solution Brief: Kopano Renewal Desk

**Agreed direction:** fix contactability and next-action discipline before automating channels. Phase 1 is a Renewal Desk:

- one customer record
- verified contact points with a consent status
- a 90-day renewal queue
- mandatory dated next actions
- template messaging only to consented, contactable customers
- a manager exceptions view

Bulk outreach is out of scope until the contactable share passes 60%.
`;

type Row = Record<string, string | number | boolean | null>;

export interface Table {
  name: string;
  columns: string[];
  rows: Row[];
}

export interface BundleB {
  tables: Table[];
  seedSql: string;
  readme: string;
  solutionBrief: string;
  meta: Record<string, number | string>;
}

const TABLE_DDL: Record<string, string> = {
  customers: `create table if not exists public.customers (
  id bigint primary key,
  legal_name text not null,
  reg_no text,
  segment text not null check (segment in ('SME', 'LE', 'PE')),
  normalised_name text not null
);`,
  accounts: `create table if not exists public.accounts (
  id bigint primary key,
  customer_id bigint not null references public.customers (id),
  account_no text not null unique,
  dealer_code text
);`,
  lines: `create table if not exists public.lines (
  id bigint primary key,
  account_id bigint not null references public.accounts (id),
  msisdn_e164 text not null unique,
  priceplan text not null,
  term_months int,
  contract_end_date date,
  device text,
  monthly_charge_zar numeric(10, 2),
  status text not null check (status in ('in_contract', 'out_of_contract', 'unknown')),
  eligible_from date
);`,
  contact_points: `create table if not exists public.contact_points (
  id bigint primary key,
  customer_id bigint not null references public.customers (id),
  type text not null check (type in ('mobile', 'landline', 'email', 'whatsapp')),
  value text not null,
  role text not null check (role in ('decision_maker', 'admin', 'unknown')),
  verified_at timestamptz,
  consent_status text not null check (consent_status in ('opted_in', 'existing_customer_s69_3', 'opted_out', 'unknown')),
  source text not null
);`,
  agents: `create table if not exists public.agents (
  id bigint primary key,
  name text not null,
  role text not null check (role in ('agent', 'manager', 'admin'))
);`,
  interactions: `create table if not exists public.interactions (
  id bigint primary key,
  customer_id bigint not null references public.customers (id),
  agent_id bigint not null references public.agents (id),
  type text not null check (type in ('call', 'whatsapp', 'sms', 'email')),
  outcome text not null,
  next_action_at timestamptz,
  notes text,
  created_at timestamptz not null
);`,
  templates: `create table if not exists public.templates (
  id bigint primary key,
  name text not null,
  category text not null check (category in ('utility', 'marketing')),
  body text not null,
  approved boolean not null
);`,
};

function titleCase(upper: string): string {
  return upper
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\(Pty\) Ltd/i, "(Pty) Ltd")
    .replace(/\bCc\b/, "CC")
    .replace(/\b([A-Z])([A-Z])\b/gi, (m) => m.toUpperCase());
}

const csvCell = (v: Row[string]) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(t: Table): string {
  return [t.columns.join(","), ...t.rows.map((r) => t.columns.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

const sqlValue = (v: Row[string]) => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return `'${v.replace(/'/g, "''")}'`;
};

export function toSeedSql(tables: Table[], header: string): string {
  const parts = [header, "begin;", ...tables.map((t) => TABLE_DDL[t.name])];
  for (const t of tables) {
    for (let i = 0; i < t.rows.length; i += 500) {
      const chunk = t.rows.slice(i, i + 500);
      parts.push(
        `insert into public.${t.name} (${t.columns.join(", ")}) values\n${chunk.map((r) => `  (${t.columns.map((c) => sqlValue(r[c])).join(", ")})`).join(",\n")};`,
      );
    }
  }
  parts.push("commit;");
  return parts.join("\n\n") + "\n";
}

const ts = (d: Date, hour: number, minute: number) => new Date(d.getTime() + (hour * 60 + minute) * 60_000).toISOString();

export function buildBundleB(a: BundleA, seed: number, version: string): BundleB {
  const rng = createSynthRng(seed).fork("bundle_b");
  const { base } = a;
  const exportDate = base.exportDate;

  const customers: Row[] = base.customers.map((c) => ({
    id: c.id,
    legal_name: titleCase(c.company.name),
    reg_no: c.regNo,
    segment: c.segment,
    normalised_name: c.company.normalised.toLowerCase(),
  }));
  const accountId = new Map<number, number>();
  const accounts: Row[] = [...base.accounts]
    .sort((x, y) => x.customerId - y.customerId || x.accountNo - y.accountNo)
    .map((acc, i) => {
      accountId.set(acc.accountNo, i + 1);
      return { id: i + 1, customer_id: acc.customerId, account_no: String(acc.accountNo), dealer_code: acc.dealerCode };
    });

  const lines: Row[] = base.lines.map((l, i) => {
    const epoch = l.kind === "epoch";
    const end = epoch ? null : l.endDate;
    const status = end === null ? "unknown" : end < exportDate ? "out_of_contract" : "in_contract";
    // H07: upgrades open three months before the end date; a few plans only in the last month.
    const eligible = end === null ? null : addMonths(end, l.plan.lastMonthOnly ? -1 : -3);
    return {
      id: i + 1,
      account_id: accountId.get(l.accountNo)!,
      msisdn_e164: toE164(l.mobile),
      priceplan: l.plan.name,
      term_months: epoch ? null : l.term,
      contract_end_date: end ? iso(end) : null,
      device: l.device ? `${l.device.manufacturer} ${l.device.model}` : null,
      monthly_charge_zar: l.chg,
      status,
      eligible_from: eligible ? iso(eligible) : null,
    };
  });

  // Contact points: ~45% of customers have at least one verified, consented contact point.
  const phones = new Set(base.lines.map((l) => l.mobile));
  const contactPoints: Row[] = [];
  for (const c of base.customers) {
    const kind = rng.weighted([
      ["contactable", 43],
      ["none", 22],
      ["unverified", 17],
      ["unknown_consent", 9],
      ["opted_out", 7],
    ] as const);
    if (kind === "none") continue;
    const person = makePerson(rng);
    const n = rng.weighted([[1, 50], [2, 35], [3, 15]] as const);
    for (let k = 0; k < n; k++) {
      const type = k === 0 ? rng.weighted([["mobile", 70], ["email", 20], ["landline", 10]] as const) : rng.weighted([["mobile", 30], ["email", 35], ["landline", 20], ["whatsapp", 15]] as const);
      const mobile = makeMobile(rng, phones);
      const value = type === "email" ? (rng.chance(0.6) ? personEmail(person) : companyEmail(c.company, rng)) : type === "landline" ? toE164(makeLandline(rng, phones)) : toE164(mobile);
      const first = k === 0;
      const verified = kind === "contactable" ? first || rng.chance(0.5) : kind === "unverified" ? false : kind === "unknown_consent" ? rng.chance(0.7) : rng.chance(0.5);
      const consent =
        kind === "contactable"
          ? first
            ? rng.weighted([["existing_customer_s69_3", 60], ["opted_in", 40]] as const)
            : rng.weighted([["existing_customer_s69_3", 45], ["opted_in", 30], ["unknown", 25]] as const)
          : kind === "opted_out"
            ? "opted_out"
            : kind === "unknown_consent"
              ? "unknown"
              : rng.weighted([["unknown", 60], ["existing_customer_s69_3", 40]] as const);
      contactPoints.push({
        id: contactPoints.length + 1,
        customer_id: c.id,
        type,
        value,
        role: rng.weighted([["decision_maker", 45], ["admin", 40], ["unknown", 15]] as const),
        verified_at: verified ? ts(addDays(exportDate, -rng.int(1, 40)), rng.int(8, 16), rng.int(0, 59)) : null,
        consent_status: consent,
        source: kind === "opted_out" && first ? "legal_list" : rng.weighted([["agent_sheet", 45], ["call_capture", 40], ["network_portal", 15]] as const),
      });
    }
  }
  const contactable = new Set(
    contactPoints.filter((p) => p.verified_at !== null && (p.consent_status === "opted_in" || p.consent_status === "existing_customer_s69_3")).map((p) => p.customer_id as number),
  );

  const { agents: agentPeople, am, consultant } = a.people;
  const admin = makePerson(rng, new Set([...agentPeople, am].map((p) => p.full)));
  const agents: Row[] = [
    ...agentPeople.map((p, i) => ({ id: i + 1, name: p.full, role: "agent" })),
    { id: agentPeople.length + 1, name: am.full, role: "manager" },
    { id: agentPeople.length + 2, name: admin.full, role: "admin" },
  ];

  // ~300 historical interactions, weighted towards customers with lines in the renewal window.
  const windowCustomers = new Set(
    base.lines
      .filter((l) => l.kind === "window")
      .map((l) => base.accounts.find((acc) => acc.accountNo === l.accountNo)!.customerId),
  );
  const customerPool = [...base.customers.map((c) => c.id), ...[...windowCustomers], ...[...windowCustomers]];
  const nInteractions = rng.int(290, 315);
  const interactions: Row[] = [];
  const NOTES: Record<string, readonly string[]> = {
    call_back: ["Decision maker in a meeting, call back", "Asked for a call next week", "Bookkeeper answered; owner to call back"],
    quote_requested: ["Wants a quote for upgrades on all lines", "Quote for two new devices", "Compare data bundles"],
    sale: ["Upgraded two lines", "Renewed on Biz Smart 6GB", "Signed for new router"],
    not_interested: ["Happy with current deal", "Moving to another provider", "Not now, maybe next year"],
    no_answer: ["No answer", "Rang out"],
    voicemail: ["Left voicemail"],
    wrong_number: ["Number belongs to another company", "Number not in service"],
    message_queued: ["Contract end reminder queued", "Quote follow-up queued"],
  };
  for (let i = 0; i < nInteractions; i++) {
    const type = rng.weighted([["call", 80], ["whatsapp", 8], ["sms", 5], ["email", 7]] as const);
    const outcome =
      type === "call"
        ? rng.weighted([["no_answer", 25], ["voicemail", 15], ["call_back", 18], ["quote_requested", 9], ["sale", 6], ["not_interested", 15], ["wrong_number", 6]] as const)
        : "message_queued";
    const day = addDays(exportDate, -rng.int(1, 65));
    const createdAt = ts(day, rng.int(8, 16), rng.int(0, 59));
    let next: string | null = null;
    if (outcome === "call_back" && rng.chance(0.85)) next = ts(addDays(day, rng.int(1, 21)), rng.int(8, 16), 0);
    if (outcome === "quote_requested" && rng.chance(0.7)) next = ts(addDays(day, rng.int(2, 10)), rng.int(8, 16), 0);
    interactions.push({
      id: i + 1,
      customer_id: rng.pick(customerPool),
      agent_id: rng.int(1, agentPeople.length),
      type,
      outcome,
      next_action_at: next,
      notes: rng.pick(NOTES[outcome]),
      created_at: createdAt,
    });
  }
  interactions.sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)));
  interactions.forEach((r, i) => (r.id = i + 1));

  const templates: Row[] = [
    { id: 1, name: "Contract end reminder", category: "utility", body: "Hi {{contact_name}}, your Network contract for {{msisdn}} ends on {{end_date}}. Reply to book a call with your Kopano consultant. Reply STOP to opt out.", approved: true },
    { id: 2, name: "Callback confirmation", category: "utility", body: "Hi {{contact_name}}, {{agent_name}} from Kopano Connect will call you on {{callback_date}} as agreed. Reply STOP to opt out.", approved: true },
    { id: 3, name: "Quote follow-up", category: "utility", body: "Hi {{contact_name}}, your upgrade quote {{quote_ref}} is ready. Reply YES and we will call you to go through it. Reply STOP to opt out.", approved: true },
    { id: 4, name: "Upgrade offer", category: "marketing", body: "Hi {{contact_name}}, you can upgrade {{msisdn}} from {{eligible_from}}. Ask us about new devices on your business plan. Reply STOP to opt out.", approved: true },
    { id: 5, name: "Data bundle promotion", category: "marketing", body: "Hi {{contact_name}}, add more business data this month. Reply INFO for options. Reply STOP to opt out.", approved: false },
    { id: 6, name: "New device launch", category: "marketing", body: "Hi {{contact_name}}, the new Zanzi Z20 is available on business plans. Reply STOP to opt out.", approved: false },
  ];

  const tables: Table[] = [
    { name: "customers", columns: ["id", "legal_name", "reg_no", "segment", "normalised_name"], rows: customers },
    { name: "accounts", columns: ["id", "customer_id", "account_no", "dealer_code"], rows: accounts },
    { name: "lines", columns: ["id", "account_id", "msisdn_e164", "priceplan", "term_months", "contract_end_date", "device", "monthly_charge_zar", "status", "eligible_from"], rows: lines },
    { name: "contact_points", columns: ["id", "customer_id", "type", "value", "role", "verified_at", "consent_status", "source"], rows: contactPoints },
    { name: "agents", columns: ["id", "name", "role"], rows: agents },
    { name: "interactions", columns: ["id", "customer_id", "agent_id", "type", "outcome", "next_action_at", "notes", "created_at"], rows: interactions },
    { name: "templates", columns: ["id", "name", "category", "body", "approved"], rows: templates },
  ];

  const header = `-- Kopano Connect: cleaned renewal-desk data (kopano_clean_${version}).
-- Synthetic data for a hiring assessment. Every name, number and email is fictional.
-- Status and eligible_from are computed as of ${iso(exportDate)}.
-- Enable RLS and add policies before exposing these tables through the Data API.`;

  const readme = `# Kopano clean data (${version})

Cleaned and de-duplicated renewal-desk data for Kopano Connect, as of **${iso(exportDate)}**.
Every name, number and email address is fictional.

| File | Contents |
|---|---|
| customers.csv | One row per company: legal name, registration number, segment, normalised name |
| accounts.csv | Dealer account numbers; a customer can have more than one |
| lines.csv | One row per phone line (E.164), with price plan, contract end date, monthly charge in rands, derived status and upgrade eligibility date |
| contact_points.csv | Phone numbers and emails per customer, with role, verification time, consent status and source |
| agents.csv | Agents, the manager and an admin |
| interactions.csv | About 300 historical calls and queued messages, with outcomes and next actions |
| templates.csv | Message templates (utility or marketing) and whether the Network has approved them |
| seed.sql | All of the above as a Postgres / Supabase seed (tables + inserts) |
| solution_brief.md | The agreed direction for Phase 1 |

Notes:
- \`status\` is derived from \`contract_end_date\` (not from the old export column).
- \`eligible_from\` applies the upgrade rule: three months before the end date, or one month for the price plans that only allow last-month upgrades.
- Consent statuses: \`opted_in\`, \`existing_customer_s69_3\`, \`opted_out\`, \`unknown\`.
`;

  return {
    tables,
    seedSql: toSeedSql(tables, header),
    readme,
    solutionBrief: SOLUTION_BRIEF_MD,
    meta: {
      version,
      seed,
      customers: customers.length,
      accounts: accounts.length,
      lines: lines.length,
      contact_points: contactPoints.length,
      contactable_customers: contactable.size,
      contactable_pct: Math.round((contactable.size / customers.length) * 1000) / 10,
      interactions: interactions.length,
      consultant: consultant.full,
    },
  };
}
