/**
 * Seeds a Renewal Desk database through the app's own import code (the same functions the
 * manager's Import page uses), so a fresh project and production are loaded the same way.
 *
 *   npm run seed -- --data ./data
 *
 * --data must hold the client's files: base_month1.xlsx, contacts_agent_sheets.xlsx and
 * optouts_legal.xlsx. Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (server-side key:
 * never commit it, never expose it to the browser). Logins use SEED_PASSWORD, or a random
 * password printed once. Safe to re-run: users, reference data and imports are all idempotent.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { importBaseFile } from "../lib/import/base";
import { importContactsFile } from "../lib/import/contacts";
import { importOptoutsFile } from "../lib/import/optouts";

function loadEnvFile(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export const PRICE_PLANS: { code: string; name: string; last_month_only: boolean }[] = [
  { code: "BZT100", name: "Biz Talk 100", last_month_only: false },
  { code: "BZT250", name: "Biz Talk 250", last_month_only: false },
  { code: "BZT600", name: "Biz Talk 600", last_month_only: false },
  { code: "BZT1K", name: "Biz Talk Unlimited", last_month_only: false },
  { code: "BZS2G", name: "Biz Smart 2GB", last_month_only: false },
  { code: "BZS6G", name: "Biz Smart 6GB", last_month_only: false },
  { code: "BZS15G", name: "Biz Smart 15GB", last_month_only: false },
  { code: "BZD10G", name: "Biz Data 10GB", last_month_only: false },
  { code: "BZD50G", name: "Biz Data 50GB", last_month_only: false },
  { code: "BZDUNC", name: "Biz Data Uncapped", last_month_only: false },
  // BR-E2: these two may only renew in the last month before the contract ends.
  { code: "BZF150", name: "Biz Flexi Top-Up 150", last_month_only: true },
  { code: "FLT50M", name: "Fleet Track M2M 50MB", last_month_only: true },
];

export const TEMPLATES: { name: string; category: "utility" | "marketing"; body: string; approved: boolean }[] = [
  {
    name: "Contract end reminder",
    category: "utility",
    approved: true,
    body: "Hi, this is Kopano Connect. The contract on your business line ending {{last4}} ends on {{end_date}}. Reply CALL and your account consultant will phone you about renewal options. Reply STOP to opt out.",
  },
  {
    name: "Renewal call confirmation",
    category: "utility",
    approved: true,
    body: "Hi, this is Kopano Connect confirming your renewal call on {{callback_at}}. Reply STOP to opt out.",
  },
  {
    name: "Upgrade offer",
    category: "marketing",
    approved: true,
    body: "Kopano Connect: your business qualifies for a device upgrade when you renew. Reply YES and we will call you. Reply STOP to opt out.",
  },
  {
    name: "Year-end promotion (awaiting Network approval)",
    category: "marketing",
    approved: false,
    body: "Kopano Connect year-end deals on business devices. Reply YES for a call. Reply STOP to opt out.",
  },
];

const USERS = [
  { key: "agent_a", role: "agent", name: "Palesa Mokoena", email: process.env.SEED_AGENT_A_EMAIL ?? "agent.a@example.co.za" },
  { key: "agent_b", role: "agent", name: "Sipho Ndlovu", email: process.env.SEED_AGENT_B_EMAIL ?? "agent.b@example.co.za" },
  { key: "manager", role: "manager", name: "Desk Manager", email: process.env.SEED_MANAGER_EMAIL ?? "manager@example.co.za" },
] as const;

async function findUserId(admin: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

export async function ensureUser(admin: SupabaseClient, u: { email: string; name: string; role: string }, password: string): Promise<string> {
  let id = await findUserId(admin, u.email);
  if (id) {
    const { error } = await admin.auth.admin.updateUserById(id, { password, email_confirm: true });
    if (error) throw error;
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email: u.email, password, email_confirm: true, user_metadata: { name: u.name } });
    if (error) throw error;
    id = data.user.id;
  }
  const { error } = await admin.from("agents").upsert({ id, name: u.name, email: u.email, role: u.role }, { onConflict: "id" });
  if (error) throw error;
  return id;
}

/** All rows of a table, a page at a time (hosted projects cap a response at 1,000 rows). */
async function selectAll<T>(admin: SupabaseClient, table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from(table).select(columns).order("id").range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) return out;
  }
}

/** BR-A1: every customer has one agent. New customers are shared out alternately by name. */
export async function allocateUnallocated(admin: SupabaseClient, agentIds: string[]): Promise<number> {
  const customers = await selectAll<{ id: string; normalised_name: string }>(admin, "customers", "id, normalised_name");
  const allocated = new Set((await selectAll<{ id: string; customer_id: string }>(admin, "allocations", "id, customer_id")).map((a) => a.customer_id));
  const todo = customers.filter((c) => !allocated.has(c.id)).sort((a, b) => a.normalised_name.localeCompare(b.normalised_name));
  const rows = todo.map((c, i) => ({ customer_id: c.id, agent_id: agentIds[(allocated.size + i) % agentIds.length] }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("allocations").upsert(rows.slice(i, i + 500), { onConflict: "customer_id", ignoreDuplicates: true });
    if (error) throw error;
  }
  return rows.length;
}

async function main() {
  loadEnvFile(path.resolve(".env.local"));
  loadEnvFile(path.resolve(".env"));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (in .env.local or the environment).");
  const dataDir = path.resolve(arg("data", "data"));
  const files = { base: "base_month1.xlsx", contacts: "contacts_agent_sheets.xlsx", optouts: "optouts_legal.xlsx" };
  for (const f of Object.values(files)) if (!fs.existsSync(path.join(dataDir, f))) throw new Error(`${path.join(dataDir, f)} not found (pass --data <folder with the client's files>)`);

  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const generated = !process.env.SEED_PASSWORD;
  const password = process.env.SEED_PASSWORD ?? `Desk-${randomBytes(9).toString("base64url")}`;

  const ids: Record<string, string> = {};
  for (const u of USERS) ids[u.key] = await ensureUser(admin, u, password);
  console.log("users: 2 agents + 1 manager");

  {
    const { error } = await admin.from("priceplan_rules").upsert(PRICE_PLANS, { onConflict: "code" });
    if (error) throw error;
    const { error: tErr } = await admin.from("templates").upsert(TEMPLATES, { onConflict: "name" });
    if (tErr) throw tErr;
    console.log(`reference data: ${PRICE_PLANS.length} price plans, ${TEMPLATES.length} templates`);
  }

  const read = (f: string) => fs.readFileSync(path.join(dataDir, f));
  const base = await importBaseFile(admin, files.base, read(files.base));
  console.log(`base: ${JSON.stringify(base.counts)}`);
  const contacts = await importContactsFile(admin, files.contacts, read(files.contacts));
  console.log(`contacts: ${JSON.stringify(contacts.counts)}`);
  const optouts = await importOptoutsFile(admin, files.optouts, read(files.optouts));
  console.log(`opt-outs: ${JSON.stringify(optouts.counts)}`);
  const allocated = await allocateUnallocated(admin, [ids.agent_a, ids.agent_b]);
  console.log(`allocations: ${allocated} new`);

  console.log("\ntest_logins:");
  for (const u of USERS) console.log(`${u.role}: ${u.email} / ${password}`);
  if (generated) console.log("\n(The password was generated for this run. Set SEED_PASSWORD to choose it.)");
}

if (/seed\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
