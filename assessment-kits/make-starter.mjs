#!/usr/bin/env node
/**
 * INTERNAL. Builds the SWE Test 1 starter repo (the BA's "vibe-coded" MVP) from the reference app.
 *
 *   node assessment-kits/make-starter.mjs --out <dir> [--internal-out <dir>] [--force] [--secret-seed <text>]
 *
 * 1. Copies assessment-kits/kopano-renewal-desk into <dir> (no node_modules, .next, .env files,
 *    data/ or local Supabase state).
 * 2. Injects the planted faults F01–F14 from docs/07, one named transformation per fault. Each
 *    transformation is idempotent (re-running it on a faulted tree changes nothing) and is verified
 *    right after it runs; every check runs again on the finished tree.
 * 3. Makes it look like the BA left it: their README, a simple CI, only the tests they wrote, no
 *    reference docs.
 * 4. Builds a fresh git history in <dir> (F13: .env.local with a fake key committed early and
 *    deleted later, so the key is still in history).
 *
 * Internal artefacts go to --internal-out (default <dir>.internal): live-db.sql (the BA's
 * "dashboard" database: deploy the starter on it to calibrate the harness) and faults.json.
 * Never give candidates those files, this script, FAULTS.md or docs/07 and docs/16.
 *
 * The planted key is an obviously fake, high-entropy string with no real provider prefix,
 * derived from --secret-seed, so GitHub push protection has nothing to block.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE = path.join(HERE, "kopano-renewal-desk");

// ───────────────────────── Arguments ─────────────────────────

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const outArg = arg("out");
if (!outArg) {
  console.error("usage: node assessment-kits/make-starter.mjs --out <dir> [--internal-out <dir>] [--force] [--secret-seed <text>]");
  process.exit(2);
}
const OUT = path.resolve(outArg);
const INTERNAL = path.resolve(arg("internal-out", `${OUT}.internal`));
const FORCE = process.argv.includes("--force");
const SECRET_SEED = arg("secret-seed", "kopano-renewal-desk starter v1");

const inside = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);
function refuse(message) {
  console.error(`make-starter: ${message}`);
  process.exit(2);
}
if (inside(OUT, REFERENCE) || inside(REFERENCE, OUT)) {
  refuse("--out must be outside the reference app");
}
// The internal artefacts (live-db.sql, faults.json with the planted key) must never land in the
// starter's tree, where the last commit (`git add -A`) would hand them to candidates.
if (inside(INTERNAL, OUT) || inside(OUT, INTERNAL)) {
  refuse("--internal-out must be outside --out (and must not contain it)");
}
if (inside(INTERNAL, REFERENCE) || inside(REFERENCE, INTERNAL)) {
  refuse("--internal-out must be outside the reference app");
}

// ───────────────────────── File helpers ─────────────────────────

const abs = (rel) => path.join(OUT, rel);
const exists = (rel) => fs.existsSync(abs(rel));
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
function write(rel, text) {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text);
}
function remove(rel) {
  fs.rmSync(abs(rel), { recursive: true, force: true });
}
const count = (text, needle) => text.split(needle).length - 1;

class FaultError extends Error {}

/**
 * Replaces `from` with `to` in a file, exactly once. Idempotent: when `from` is gone and the
 * result is already there (`to`, or `done` for removals), nothing changes. Anything else means
 * the reference changed and the transformation must be updated, so it throws.
 */
function edit(rel, from, to, { label, done } = {}) {
  const text = read(rel);
  // When the result contains the anchor (an insertion), "already applied" must be checked first.
  if (to && to.includes(from) && text.includes(to)) return;
  const n = count(text, from);
  if (n === 1) {
    write(rel, text.replace(from, () => to));
    return;
  }
  if (n > 1) throw new FaultError(`${label ?? rel}: anchor occurs ${n} times in ${rel}`);
  const applied = to ? text.includes(to) : done ? (typeof done === "function" ? done(text) : text.includes(done)) : false;
  if (!applied) throw new FaultError(`${label ?? rel}: anchor not found in ${rel} (did the reference change?)\n--- anchor ---\n${from}`);
}

/** Replaces the text from `start` up to and including `end` (both unique). */
function editBetween(rel, start, end, to, { label, done } = {}) {
  const text = read(rel);
  const i = text.indexOf(start);
  if (i < 0 || count(text, start) > 1) {
    const applied = done ? (typeof done === "function" ? done(text) : text.includes(done)) : text.includes(to);
    if (i < 0 && applied) return;
    throw new FaultError(`${label ?? rel}: start anchor ${i < 0 ? "not found" : "not unique"} in ${rel}: ${start.slice(0, 80)}`);
  }
  const j = text.indexOf(end, i + start.length);
  if (j < 0) throw new FaultError(`${label ?? rel}: end anchor not found in ${rel}: ${end.slice(0, 80)}`);
  write(rel, text.slice(0, i) + to + text.slice(j + end.length));
}

function check(cond, message) {
  if (!cond) throw new FaultError(`verification failed: ${message}`);
}

// ───────────────────────── SQL helpers ─────────────────────────

/** Splits SQL into statements (each with its leading comments), respecting quotes and $$ bodies. */
function splitSql(sql) {
  const out = [];
  let start = 0;
  let i = 0;
  let dollar = null;
  while (i < sql.length) {
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        i += dollar.length;
        dollar = null;
      } else i++;
      continue;
    }
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl + 1;
      continue;
    }
    if (c === "'") {
      const j = sql.indexOf("'", i + 1);
      i = j < 0 ? sql.length : j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 40));
      if (m) {
        dollar = m[0];
        i += dollar.length;
        continue;
      }
    }
    if (c === ";") {
      out.push(sql.slice(start, i + 1));
      start = i + 1;
    }
    i++;
  }
  if (start < sql.length) out.push(sql.slice(start));
  return out;
}

const sqlCode = (statement) => statement.replace(/--[^\n]*/g, "").trim();

/** Removes every statement whose code matches `pattern`. Returns how many were removed. */
function removeStatements(rel, pattern) {
  const parts = splitSql(read(rel));
  const kept = parts.filter((p) => !pattern.test(sqlCode(p)));
  if (kept.length !== parts.length) write(rel, kept.join(""));
  return parts.length - kept.length;
}

function statementsMatching(text, pattern) {
  return splitSql(text).filter((p) => pattern.test(sqlCode(p)));
}

const MIG = "supabase/migrations";
const M_SCHEMA = `${MIG}/20261001000001_schema.sql`;
const M_SECURITY = `${MIG}/20261001000002_security.sql`;
const M_RULES = `${MIG}/20261001000003_rules.sql`;
const M_IMPORT = `${MIG}/20261001000004_import.sql`;
const M_RATE = `${MIG}/20261001000005_rate_limit.sql`;
const M_HARDEN = `${MIG}/20261001000006_hardening.sql`;

// ───────────────────────── Copy ─────────────────────────

const SKIP = new Set(["node_modules", ".next", "data", "coverage", ".vercel", ".git", "out"]);
function copyReference() {
  if (fs.existsSync(OUT) && fs.readdirSync(OUT).length) {
    if (!FORCE) throw new Error(`${OUT} is not empty (pass --force to replace it)`);
    fs.rmSync(OUT, { recursive: true, force: true });
  }
  fs.cpSync(REFERENCE, OUT, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(REFERENCE, src);
      if (!rel) return true;
      const parts = rel.split(path.sep);
      if (SKIP.has(parts[0])) return false;
      if (rel === path.join("supabase", ".temp") || rel === path.join("supabase", ".branches")) return false;
      const base = path.basename(rel);
      if (base.startsWith(".env") && base !== ".env.example") return false;
      if (base.endsWith(".tsbuildinfo") || base === "next-env.d.ts") return false;
      return true;
    },
  });
}

// ───────────────────────── The planted faults ─────────────────────────

/** F01: `customers` has RLS disabled (its policy is still there, which makes it easy to miss). */
function F01_customersRlsDisabled() {
  edit(M_SECURITY, "alter table public.customers enable row level security;\n", "", {
    label: "F01",
    done: (t) => !t.includes("alter table public.customers enable row level security") && t.includes("alter table public.accounts enable row level security"),
  });
}
F01_customersRlsDisabled.verify = (sql) => {
  check(!/alter table public\.customers enable row level security/.test(sql), "F01: customers must not enable RLS");
  check(/create policy customers_select/.test(sql), "F01: the customers policy should still exist (RLS just isn't on)");
};

/** F02: any signed-in user can read every interaction (`using (true)`). */
function F02_interactionsPolicyUsingTrue() {
  edit(
    M_SECURITY,
    "create policy interactions_select on public.interactions for select to authenticated\n  using (public.can_see_customer(customer_id));",
    "create policy interactions_select on public.interactions for select to authenticated\n  using (true);",
    { label: "F02" },
  );
}
F02_interactionsPolicyUsingTrue.verify = (sql) => {
  check(/create policy interactions_select on public\.interactions for select to authenticated\s+using \(true\);/.test(sql), "F02: interactions select policy must be using (true)");
};

/** F03: default anon grants left in place, plus a permissive anon policy on `lines` "for the demo". */
function F03_anonDemoPolicyOnLines() {
  edit(
    M_SECURITY,
    "-- Nothing is readable or writable without signing in.\nrevoke all on all tables in schema public from anon;\nalter default privileges in schema public revoke all on tables from anon;\n",
    "-- Demo: the landing page shows line counts before login.\ngrant select on public.lines to anon;\ncreate policy lines_demo_read on public.lines for select to anon\n  using (true);\n",
    { label: "F03" },
  );
}
F03_anonDemoPolicyOnLines.verify = (sql) => {
  check(/create policy lines_demo_read on public\.lines for select to anon\s+using \(true\)/.test(sql), "F03: anon demo policy on lines");
  check(!/revoke all on all tables in schema public from anon/.test(sql), "F03: anon grants must be left in place");
};

const STARTER_OUTCOME_FORM = `"use client";

import { createClient } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";
import { useState } from "react";

const OPTIONS = [
  ["call_back", "Call back"],
  ["quote", "Quote requested"],
  ["sale", "Sale"],
  ["not_interested", "Not interested"],
  ["no_answer", "No answer"],
] as const;

export function OutcomeForm({ customerId, agentId }: { customerId: string; agentId: string }) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<string>("call_back");
  const [when, setWhen] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (outcome === "call_back" && !when) {
      setError("Pick a callback date and time.");
      return;
    }
    setBusy(true);
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_SERVICE_KEY!);
    const { error: saveError } = await supabase.from("interactions").insert({
      customer_id: customerId,
      agent_id: agentId,
      outcome,
      next_action_at: when ? new Date(when).toISOString() : null,
      notes: notes || null,
    });
    setBusy(false);
    if (saveError) {
      setError("The outcome could not be saved.");
      return;
    }
    setSaved(true);
    setNotes("");
    setWhen("");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="label" htmlFor="outcome">
          Outcome
        </label>
        <select className="input" id="outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          {OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="when">
          Next action {outcome === "call_back" ? "(required)" : "(optional)"}
        </label>
        <input className="input" id="when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required={outcome === "call_back"} />
      </div>
      <div>
        <label className="label" htmlFor="notes">
          Notes
        </label>
        <textarea className="input" id="notes" rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}
      {saved && <p className="ok">Saved.</p>}
      <button className="btn" disabled={busy} type="submit">
        {busy ? "Saving…" : "Log outcome"}
      </button>
    </form>
  );
}
`;

const STARTER_ENV_EXAMPLE = `NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
NEXT_PUBLIC_SUPABASE_SERVICE_KEY=
SUPABASE_SECRET_KEY=

OPENROUTER_API_KEY=
OPENROUTER_MODEL=openai/gpt-4o-mini
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

SEED_PASSWORD=
`;

/** F04: the server key is exposed as NEXT_PUBLIC_SUPABASE_SERVICE_KEY and used by a client component. */
function F04_serviceKeyInClientComponent() {
  write("components/OutcomeForm.tsx", STARTER_OUTCOME_FORM);
  edit("app/customers/[id]/page.tsx", "<OutcomeForm customerId={customer.id} />", "<OutcomeForm customerId={customer.id} agentId={caller.userId} />", { label: "F04" });
  write(".env.example", STARTER_ENV_EXAMPLE);
}
F04_serviceKeyInClientComponent.verify = () => {
  const form = read("components/OutcomeForm.tsx");
  check(form.startsWith('"use client"') && form.includes("process.env.NEXT_PUBLIC_SUPABASE_SERVICE_KEY"), "F04: client component uses NEXT_PUBLIC_SUPABASE_SERVICE_KEY");
  check(read(".env.example").includes("NEXT_PUBLIC_SUPABASE_SERVICE_KEY="), "F04: .env.example lists the public service key");
  check(read("app/customers/[id]/page.tsx").includes("agentId={caller.userId}"), "F04: page passes agentId");
};

/** F05: /api/summary has no auth, no rate limit and no max tokens. */
function F05_summaryRouteUnprotected() {
  const route = "app/api/summary/route.ts";
  edit(route, 'import { getCaller } from "@/lib/auth";\n', "", { label: "F05", done: (t) => !t.includes("getCaller") });
  edit(route, 'import { retryAfterSeconds, takeRateLimit } from "@/lib/rate-limit";\n', "", { label: "F05", done: (t) => !t.includes("takeRateLimit") });
  edit(route, 'import { buildSummaryMessages, loadSummaryContext } from "@/lib/summary";\n', 'import { buildSummaryMessages, loadSummaryContext } from "@/lib/summary";\nimport { createAdminClient } from "@/lib/supabase/admin";\n', { label: "F05" });
  edit(route, "/** Per-user caps on the paid AI call (documented in the README). */\nconst PER_MINUTE = 5;\nconst PER_DAY = 60;\n\n", "", { label: "F05", done: (t) => !t.includes("PER_MINUTE") });
  editBetween(route, "  const caller = await getCaller(req);\n", "    }\n  }\n\n", "  const db = createAdminClient();\n\n", { label: "F05", done: "  const db = createAdminClient();\n" });
  edit(route, "loadSummaryContext(caller.db, parsed.data.customerId)", "loadSummaryContext(db, parsed.data.customerId)", { label: "F05" });
  edit("lib/openrouter.ts", "/** Cost cap per summary: a few short paragraphs. */\nexport const MAX_SUMMARY_TOKENS = 400;\n\n", "", { label: "F05", done: (t) => !t.includes("MAX_SUMMARY_TOKENS = ") });
  edit("lib/openrouter.ts", "    max_tokens: MAX_SUMMARY_TOKENS,\n", "", { label: "F05", done: (t) => !t.includes("max_tokens") });
  remove("lib/rate-limit.ts");
  remove(M_RATE);
}
F05_summaryRouteUnprotected.verify = () => {
  const route = read("app/api/summary/route.ts");
  check(!/getCaller|takeRateLimit|429|401/.test(route) && route.includes("createAdminClient()"), "F05: summary route has no auth and no rate limit");
  check(!read("lib/openrouter.ts").includes("max_tokens"), "F05: no max_tokens");
  check(!exists("lib/rate-limit.ts") && !exists(M_RATE), "F05: rate limiting removed");
};

const STARTER_SUMMARY_PROMPT = `export function buildSummaryMessages(ctx: SummaryContext, question?: string): ChatMessage[] {
  const prompt = "You are a sales assistant for Kopano Connect. " + (question || "Summarise this customer for the agent.") + "\\n\\n" +
    "Customer: " + ctx.customer.legal_name + " (" + (ctx.customer.segment ?? "SME") + ")\\n" +
    "Accounts: " + ctx.accounts.map((a) => a.account_no).join(", ") + "\\n" +
    "Lines: " + JSON.stringify(ctx.lines) + "\\n" +
    "Contacts: " + JSON.stringify(ctx.contacts) + "\\n" +
    "Recent calls: " + JSON.stringify(ctx.interactions) + "\\n\\n" +
    "Other customers in the renewal window, for comparison: " + JSON.stringify(ctx.peers) + "\\n\\n" +
    "Answer in a few bullet points.";
  return [{ role: "user", content: prompt }];
}
`;

/** F06: the agent's text goes straight into the prompt, next to other customers' data. */
function F06_promptMixesUserTextAndOtherCustomers() {
  const f = "lib/summary.ts";
  editBetween(f, '/**\n * The "AI summary" for one customer.', " */\n", '/** The "AI summary" for one customer. */\n', { label: "F06", done: '/** The "AI summary" for one customer. */\n' });
  edit(f, "  optedOut: boolean;\n}\n", "  optedOut: boolean;\n  peers: { legal_name: string; monthly_charges_zar: number; first_end_date: string; last_outcome: string | null }[];\n}\n", { label: "F06" });
  edit(
    f,
    '    db.rpc("customer_opted_out", { p_customer_id: customerId }),\n  ]);\n',
    '    db.rpc("customer_opted_out", { p_customer_id: customerId }),\n  ]);\n  const { data: peers } = await db\n    .from("renewal_queue")\n    .select("legal_name, monthly_charges_zar, first_end_date, last_outcome")\n    .neq("customer_id", customerId)\n    .order("monthly_charges_zar", { ascending: false })\n    .limit(25);\n',
    { label: "F06" },
  );
  edit(f, "    optedOut: optedOut.data === true,\n  };\n", "    optedOut: optedOut.data === true,\n    peers: peers ?? [],\n  };\n", { label: "F06" });
  const text = read(f);
  const i = text.indexOf("const HIDDEN = new Set(");
  if (i >= 0) write(f, text.slice(0, i) + STARTER_SUMMARY_PROMPT);
  else check(text.includes("Other customers in the renewal window"), "F06: summary prompt anchor");
}
F06_promptMixesUserTextAndOtherCustomers.verify = () => {
  const s = read("lib/summary.ts");
  check(s.includes("(question ||") && s.includes("JSON.stringify(ctx.peers)") && s.includes('from("renewal_queue")'), "F06: question interpolated next to other customers' data");
  check(!s.includes("<agent_question>") && !s.includes("treated as data"), "F06: no delimiting");
};

const STARTER_BASE_IMPORT = `import type { SupabaseClient } from "@supabase/supabase-js";
import { BASE_COLUMNS } from "./columns";
import { deriveContractStatus, integer, money, normaliseCompanyName, normalisePhone, text, type Cell } from "./normalise";
import { readWorkbook } from "./xlsx";

/**
 * Monthly import of the Network's base export. Each upload replaces last month's base.
 */

function toDate(v: Cell | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function chunks<T>(rows: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export async function importBaseFile(db: SupabaseClient, fileName: string, buffer: ArrayBuffer | Buffer) {
  const [sheet] = await readWorkbook(buffer);
  const missing = BASE_COLUMNS.filter((c) => !sheet.headers.includes(c));
  if (missing.length) throw new Error(fileName + " is missing columns: " + missing.join(", "));

  // Start from a clean slate: this month's file is the whole base.
  await db.from("lines").delete().not("id", "is", null);
  await db.from("accounts").delete().not("id", "is", null);
  await db.from("customers").delete().not("id", "is", null);

  const customers = new Map<string, { legal_name: string; normalised_name: string; reg_no: string | null; segment: string | null }>();
  const accounts = new Map<string, { customer: string; dealer_code: string | null }>();
  for (const { cells } of sheet.rows) {
    const name = text(cells["Customer Name"]) ?? "Unknown";
    if (!customers.has(name)) customers.set(name, { legal_name: name, normalised_name: normaliseCompanyName(name), reg_no: text(cells["Reg No"]), segment: text(cells["Segment"]) });
    const accountNo = String(cells["Account No"]);
    if (!accounts.has(accountNo)) accounts.set(accountNo, { customer: name, dealer_code: text(cells["dealer_code"]) });
  }

  const customerIds = new Map<string, string>();
  for (const batch of chunks([...customers.values()])) {
    const { data, error } = await db.from("customers").insert(batch).select("id, legal_name");
    if (error) throw new Error("customers: " + error.message);
    for (const c of data ?? []) customerIds.set(c.legal_name, c.id);
  }

  const accountIds = new Map<string, string>();
  const accountRows = [...accounts].map(([account_no, a]) => ({ account_no, customer_id: customerIds.get(a.customer), dealer_code: a.dealer_code }));
  for (const batch of chunks(accountRows)) {
    const { data, error } = await db.from("accounts").insert(batch).select("id, account_no");
    if (error) throw new Error("accounts: " + error.message);
    for (const a of data ?? []) accountIds.set(a.account_no, a.id);
  }

  const lines = [];
  for (const { cells } of sheet.rows) {
    const phone = normalisePhone(cells["Msisdn"]);
    if (!phone.ok) continue;
    const endDate = toDate(cells["Contract End Date"]);
    lines.push({
      account_id: accountIds.get(String(cells["Account No"])),
      msisdn_e164: phone.e164,
      number_type: phone.type,
      priceplan: text(cells["Priceplan"]),
      priceplan_name: text(cells["Priceplan Name"]),
      term_months: integer(cells["Contract Term"]),
      contract_end_date: endDate,
      contract_status: deriveContractStatus(endDate),
      device: [text(cells["Device Type"]), text(cells["Device Model"])].filter(Boolean).join(": ") || null,
      monthly_charge_zar: money(cells["chg_subs"]),
      active: true,
    });
  }
  for (const batch of chunks(lines)) {
    const { error } = await db.from("lines").insert(batch);
    if (error) throw new Error("lines: " + error.message);
  }

  return { runId: "", kind: "base" as const, fileName, counts: { customers: customers.size, accounts: accounts.size, lines: lines.length }, quarantine: [] };
}
`;

const STARTER_IMPORT_ROUTE = `import { getCaller } from "@/lib/auth";
import { errorJson, json } from "@/lib/http";
import { importBaseFile } from "@/lib/import/base";
import { importContactsFile } from "@/lib/import/contacts";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** Manager uploads the monthly export (multipart \`file\`; \`kind\` = base | contacts). */
export async function POST(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return errorJson(401, "Sign in first.");
  if (!caller.isManager) return errorJson(403, "Only a manager can import files.");
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return errorJson(400, "Upload a file.");
  const buffer = Buffer.from(await file.arrayBuffer());
  const db = createAdminClient();
  try {
    const result = form.get("kind") === "contacts" ? await importContactsFile(db, file.name, buffer) : await importBaseFile(db, file.name, buffer);
    return json({ ok: true, message: "Import complete.", ...result });
  } catch (err) {
    return errorJson(500, (err as Error).message);
  }
}
`;

/** F08: the import deletes everything and re-inserts, so IDs change every month and history is orphaned. */
function F08_importDeletesAndReinserts() {
  write("lib/import/base.ts", STARTER_BASE_IMPORT);
  write("app/api/import/route.ts", STARTER_IMPORT_ROUTE);
  // The DB had to let the delete through: history tables lost their foreign keys, the base cascades.
  const schema = read(M_SCHEMA);
  const parts = splitSql(schema).map((p) => {
    const code = sqlCode(p);
    if (/^create table public\.accounts\b/.test(code)) return p.replace("references public.customers (id),", "references public.customers (id) on delete cascade,");
    if (/^create table public\.lines\b/.test(code)) return p.replace("references public.accounts (id),", "references public.accounts (id) on delete cascade,");
    if (/^create table public\.(contact_points|allocations|interactions|optouts|message_queue)\b/.test(code)) return p.replace(/ references public\.customers \(id\)/g, "");
    if (/^create table public\.customers\b/.test(code)) return p.replace("  reg_no text unique,\n", "  reg_no text,\n");
    return p;
  });
  write(M_SCHEMA, parts.join(""));
  removeStatements(M_IMPORT, /public\.import_base\b/);
  edit("scripts/seed.ts", "Safe to re-run: users, reference data and imports are all idempotent.", "Run it again to reload the data.", { label: "F08" });
}
F08_importDeletesAndReinserts.verify = (sql) => {
  const base = read("lib/import/base.ts");
  check(base.includes('db.from("customers").delete()') && !base.includes("import_base") && !base.includes("upsert"), "F08: delete then insert");
  check(!/public\.import_base\b/.test(sql), "F08: import_base removed");
  check(/customer_id uuid not null references public\.customers \(id\) on delete cascade/.test(sql), "F08: accounts cascade");
  for (const t of ["contact_points", "allocations", "interactions", "optouts", "message_queue"]) {
    const stmt = statementsMatching(sql, new RegExp(`^create table public\\.${t}\\b`));
    if (stmt.length) check(!stmt[0].includes("references public.customers"), `F08: ${t} has no FK to customers (history orphaned)`);
  }
};

const STARTER_NORMALISE_PHONE = `/** Cleans up a phone cell: digits only, without the country code or the leading zero. */
export function normalisePhone(value: Cell | undefined): PhoneResult {
  const digits = String(value ?? "").replace(/\\D/g, "").replace(/^27/, "").replace(/^0+/, "");
  if (!digits) return { ok: false, reason: "missing" };
  return { ok: true, e164: digits, type: "mobile" };
}
`;

/** F09: phone numbers stored as numbers (leading zero lost); landlines not told apart. */
function F09_phonesStoredAsNumbers() {
  editBetween("lib/import/normalise.ts", "/**\n * Normalises a phone cell to E.164 text", "is not a valid South African number` };\n}\n", STARTER_NORMALISE_PHONE, { label: "F09" });
  edit("lib/import/base.ts", "      msisdn_e164: phone.e164,\n      number_type: phone.type,\n", "      msisdn_e164: Number(phone.e164),\n", { label: "F09" });
  edit(M_SCHEMA, "  msisdn_e164 text not null unique check (msisdn_e164 ~ '^\\+27[0-9]{9}$'),\n  number_type text not null check (number_type in ('mobile', 'landline')),\n", "  msisdn_e164 bigint not null unique,\n", { label: "F09" });
  edit(M_RULES, "  l.msisdn_e164,\n  l.number_type,\n", "  l.msisdn_e164,\n", { label: "F09", done: (t) => !t.includes("l.number_type") });
  // The contact-point number checks would refuse the bare digits the BA's normaliser now produces.
  editBetween(
    M_HARDEN,
    "  -- BR-C5: a phone number is E.164 text, and its type follows from the number.",
    "        using errcode = '23514', hint = 'not_landline';\n    end if;\n  end if;\n\n",
    "",
    { label: "F09", done: (t) => !t.includes("hint = 'landline'") && t.includes("create or replace function public.contact_points_guard()") },
  );
}
F09_phonesStoredAsNumbers.verify = (sql) => {
  check(/msisdn_e164 bigint not null unique/.test(sql) && !/number_type/.test(sql), "F09: msisdn bigint, no landline flag");
  check(!/hint = '(landline|phone_format|not_landline)'/.test(sql), "F09: contact points take any number as any type");
  check(read("lib/import/base.ts").includes("msisdn_e164: Number(phone.e164)"), "F09: import stores numbers");
  check(read("lib/import/normalise.ts").includes('replace(/^0+/, "")'), "F09: normaliser drops the leading zero");
};

/** F10: "Call back" without a date is only stopped by the form (no server or DB rule). */
function F10_callbackDateOnlyInUi() {
  editBetween("lib/validation.ts", "/** RD-07: a call back must carry a callback date", "\n}\n\n", "", { label: "F10", done: (t) => !t.includes("requireCallbackDate") || t.includes("export const OutcomeInput = OutcomeFields;") });
  edit("lib/validation.ts", "export const OutcomeInput = OutcomeFields.superRefine(requireCallbackDate);", "export const OutcomeInput = OutcomeFields;", { label: "F10" });
  edit("app/api/outcomes/route.ts", '    if (error.code === "23514") return errorJson(422, "A call back needs a callback date in the future.", { fields: { nextActionAt: "required" } });\n', "", { label: "F10", done: (t) => !t.includes("23514") });
  edit("app/api/outcomes/route.ts", "/** Logs a call outcome for one of the caller's customers (RD-06, RD-07). */", "/** Logs a call outcome for one of the caller's customers. */", { label: "F10" });
  removeStatements(M_SCHEMA, /interactions_call_back_needs_date/);
}
F10_callbackDateOnlyInUi.verify = (sql) => {
  check(!/interactions_call_back_needs_date/.test(sql), "F10: no DB constraint");
  const v = read("lib/validation.ts");
  check(!v.includes("superRefine") && !v.includes("requireCallbackDate"), "F10: no server-side rule");
  check(read("components/OutcomeForm.tsx").includes('outcome === "call_back" && !when'), "F10: the UI still checks (so it looks done)");
};

/** F11: contract status copied from the export's stale column instead of derived from the end date. */
function F11_statusFromExportColumn() {
  edit("lib/import/base.ts", "      contract_status: deriveContractStatus(endDate),\n", '      contract_status: text(cells["Contract Status"]) ?? "Unknown",\n', { label: "F11" });
  edit("lib/import/base.ts", "import { deriveContractStatus, integer, money,", "import { integer, money,", { label: "F11" });
  removeStatements(M_RULES, /(lines_set_contract_status|refresh_contract_status|derive_contract_status)/);
  removeStatements(M_HARDEN, /(refresh_contract_status|pg_cron|cron\.schedule)/);
  // The screens show the stored (stale) column instead of deriving it when read.
  const page = "app/customers/[id]/page.tsx";
  edit(page, 'import { deriveContractStatus } from "@/lib/import/normalise";\n', "", { label: "F11", done: (t) => !t.includes("deriveContractStatus") });
  edit(
    page,
    "                    {/* BR-E3: derived from the end date when shown, so it is never stale between imports. */}\n                    <td>{l.active ? deriveContractStatus(l.contract_end_date) : `Ported out ${day(l.ported_out_at)}`}</td>\n",
    "                    <td>{l.active ? l.contract_status : `Ported out ${day(l.ported_out_at)}`}</td>\n",
    { label: "F11" },
  );
  edit("lib/summary.ts", 'import { deriveContractStatus } from "@/lib/import/normalise";\n', "", { label: "F11", done: (t) => !t.includes("deriveContractStatus") });
  edit("lib/summary.ts", "      contract_status: deriveContractStatus(l.contract_end_date),\n", "      contract_status: l.contract_status,\n", { label: "F11" });
}
F11_statusFromExportColumn.verify = (sql) => {
  check(read("lib/import/base.ts").includes('contract_status: text(cells["Contract Status"])'), "F11: status from the export column");
  check(!/lines_set_contract_status|refresh_contract_status|pg_cron|cron\.schedule/.test(sql), "F11: no status trigger, refresh or scheduled job");
  for (const f of ["app/customers/[id]/page.tsx", "lib/summary.ts"]) {
    const t = read(f);
    check(!t.includes("deriveContractStatus") && t.includes("l.contract_status"), `F11: ${f} shows the stored status`);
  }
};

/** F12: the opt-out list is never loaded or applied to messaging. */
function F12_optoutsNotApplied() {
  edit("lib/messaging.ts", '  if (input.optedOut) return "opted_out";\n', "", { label: "F12", done: (t) => !t.includes("if (input.optedOut)") });
  editBetween("lib/messaging.ts", "/**\n * RD-11: who may be sent which template.", " */\n", "/** Who may be sent which template. */\n", { label: "F12", done: "/** Who may be sent which template. */\n" });
  edit("app/api/messages/route.ts", "/** Queues a templated message (RD-10, RD-11). Nothing is sent from the Desk. */", "/** Queues a templated message. Nothing is sent from the Desk. */", { label: "F12" });
  removeStatements(M_RULES, /message_queue_guard/);
  removeStatements(M_IMPORT, /public\.(import_optouts|match_optouts)\b/);
  removeStatements(M_HARDEN, /(message_queue_guard|public\.match_optouts\b)/);
  remove("lib/import/optouts.ts");
  edit("scripts/seed.ts", 'import { importOptoutsFile } from "../lib/import/optouts";\n', "", { label: "F12", done: (t) => !t.includes("importOptoutsFile") });
  edit("scripts/seed.ts", '  const optouts = await importOptoutsFile(admin, files.optouts, read(files.optouts));\n  console.log(`opt-outs: ${JSON.stringify(optouts.counts)}`);\n', "", { label: "F12", done: (t) => !t.includes("importOptoutsFile") });
  edit("scripts/seed.ts", ', optouts: "optouts_legal.xlsx" };', " };", { label: "F12" });
  edit("scripts/seed.ts", "base_month1.xlsx, contacts_agent_sheets.xlsx and\n * optouts_legal.xlsx.", "base_month1.xlsx and contacts_agent_sheets.xlsx.", { label: "F12" });
  edit("components/ImportForm.tsx", '  ["optouts", "Legal opt-out list"],\n', "", { label: "F12", done: (t) => !t.includes('"optouts"') });
}
F12_optoutsNotApplied.verify = (sql) => {
  check(!read("lib/messaging.ts").includes("input.optedOut)"), "F12: messaging ignores opt-outs");
  check(!/message_queue_guard|import_optouts|match_optouts/.test(sql), "F12: no DB enforcement or list import");
  check(!exists("lib/import/optouts.ts") && !read("scripts/seed.ts").includes("optouts"), "F12: the list is never loaded");
};

/** F14: no error handling: no structure check, a bad row throws or its batch is silently dropped, the route fires and forgets. */
function F14_importWithoutErrorHandling() {
  const b = "lib/import/base.ts";
  edit(b, '  const missing = BASE_COLUMNS.filter((c) => !sheet.headers.includes(c));\n  if (missing.length) throw new Error(fileName + " is missing columns: " + missing.join(", "));\n\n', "", { label: "F14", done: (t) => !t.includes("missing columns") });
  edit(b, 'import { BASE_COLUMNS } from "./columns";\n', "", { label: "F14", done: (t) => !t.includes("BASE_COLUMNS") });
  edit(b, "  if (Number.isNaN(d.getTime())) return null;\n", "", { label: "F14", done: (t) => !t.includes("Number.isNaN") });
  edit(b, '    const { data, error } = await db.from("customers").insert(batch).select("id, legal_name");\n    if (error) throw new Error("customers: " + error.message);\n', '    const { data } = await db.from("customers").insert(batch).select("id, legal_name");\n', { label: "F14" });
  edit(b, '    const { data, error } = await db.from("accounts").insert(batch).select("id, account_no");\n    if (error) throw new Error("accounts: " + error.message);\n', '    const { data } = await db.from("accounts").insert(batch).select("id, account_no");\n', { label: "F14" });
  edit(b, '    const { error } = await db.from("lines").insert(batch);\n    if (error) throw new Error("lines: " + error.message);\n', '    await db.from("lines").insert(batch);\n', { label: "F14" });
  editBetween(
    "app/api/import/route.ts",
    "  try {\n",
    "    return errorJson(500, (err as Error).message);\n  }\n",
    '  const run = form.get("kind") === "contacts" ? importContactsFile(db, file.name, buffer) : importBaseFile(db, file.name, buffer);\n  run.catch(() => undefined);\n  return json({ ok: true, message: "Import started. Refresh the queue in a minute." });\n',
    { label: "F14", done: "run.catch(() => undefined);" },
  );
  editBetween("lib/import/columns.ts", "const squash = (s: string) =>", "\n}\n", "", { label: "F14", done: (t) => !t.includes("checkColumns") });
}
F14_importWithoutErrorHandling.verify = () => {
  const b = read("lib/import/base.ts");
  check(!b.includes("missing columns") && !b.includes("throw new Error") && !b.includes("Number.isNaN"), "F14: no structure check, errors swallowed, bad dates throw");
  check(read("app/api/import/route.ts").includes("run.catch(() => undefined)"), "F14: fire-and-forget route");
  check(!read("lib/import/columns.ts").includes("checkColumns"), "F14: no column check helper left behind");
};

/** Drops the reference's narrative comments, keeping the SQL itself. */
function stripSqlComments(sql) {
  return sql
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** F07: no migrations; schema.sql is a hand export of the dashboard and it is out of date. */
function F07_noMigrationsStaleSchema() {
  if (!exists(MIG)) {
    check(exists("schema.sql"), "F07: schema.sql");
    return;
  }
  const files = fs.readdirSync(abs(MIG)).filter((f) => f.endsWith(".sql")).sort();
  const live = files.map((f) => stripSqlComments(read(`${MIG}/${f}`))).join("\n\n");
  // The BA's live database (internal, for calibration deploys): the code works against it.
  fs.mkdirSync(INTERNAL, { recursive: true });
  fs.writeFileSync(
    path.join(INTERNAL, "live-db.sql"),
    `-- INTERNAL: the starter's "live" database as the BA left it in the dashboard (faults included).\n-- Apply to a fresh Supabase project to deploy the starter for harness calibration.\n\n${live}\n`,
  );
  // What the repo has: an export taken before the last dashboard changes (message queue, template approval).
  const stale = splitSql(live)
    .filter((p) => !/message_queue/.test(sqlCode(p)))
    .join("")
    .replace("  approved boolean not null default false,\n", "");
  write("schema.sql", `-- schema.sql\n-- Exported from the Supabase SQL editor. Run it in a new project, then npm run seed.\n\n${stale.trim()}\n`);
  remove(MIG);
}
F07_noMigrationsStaleSchema.verify = () => {
  check(!exists(MIG), "F07: no supabase/migrations");
  const s = read("schema.sql");
  check(!/message_queue/.test(s) && !/approved boolean/.test(s), "F07: schema.sql is out of date (no message_queue, no templates.approved)");
  const live = fs.readFileSync(path.join(INTERNAL, "live-db.sql"), "utf8");
  check(/create table public\.message_queue/.test(live) && /approved boolean/.test(live), "F07: live-db.sql has what the code needs");
};

const fakeSecret = () => {
  const h = createHash("sha256").update(`F13:${SECRET_SEED}`).digest("base64url").replace(/[-_]/g, "");
  return `${h.slice(0, 20)}${h.slice(20, 44).split("").reverse().join("")}`;
};
const FAKE_PROJECT = createHash("sha256").update(`ref:${SECRET_SEED}`).digest("hex").replace(/\d/g, (d) => "abcdefghij"[Number(d)]).slice(0, 20);

/** F13 (part 1): .env files are not ignored. Part 2 is the history built in buildHistory(). */
function F13_envNotIgnored() {
  edit(".gitignore", "# env files: never commit secrets (copy .env.example to .env.local)\n.env*\n!.env.example\n\n", "", { label: "F13", done: (t) => !t.includes(".env*") });
}
F13_envNotIgnored.verify = () => {
  check(!/^\.env/m.test(read(".gitignore")), "F13: .env files not ignored");
};

// ───────────────────────── What the BA left (not faults) ─────────────────────────

const STARTER_README = `# Kopano Renewal Desk

Renewal desk MVP for Kopano Connect's Virtual Sales team. Built in two days with AI tools on
Next.js and Supabase.

## What it does

- **Login** for agents and managers
- **Renewal queue**: customers whose contracts end in the next 90 days
- **Customer page**: accounts, lines, contacts and call history
- **Log outcome**: call back, quote, sale, not interested, no answer
- **Message**: queue an approved WhatsApp/SMS template for the customer
- **AI summary** button to prepare for the call (OpenRouter)
- **Manager**: exceptions page, and the monthly import of the Network's base export

## Setup

1. Create a Supabase project.
2. Open the SQL editor and run \`schema.sql\`.
3. Copy \`.env.example\` to \`.env.local\` and fill in the keys (Supabase: Project Settings → API keys; OpenRouter: your key).
4. \`npm install\`
5. Put the client's files in \`./data\` (\`base_month1.xlsx\`, \`contacts_agent_sheets.xlsx\`) and run \`npm run seed -- --data ./data\`. It creates two agent logins and a manager login and prints them.
6. \`npm run dev\` and open http://localhost:3100

## Monthly import

The manager uploads the Network's export on the Import page at the start of every month.

## Notes

- Tested with the September export on my laptop.
- The AI summary uses whatever model is in \`OPENROUTER_MODEL\`.
`;

const STARTER_CI = `name: CI

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm test
      - run: npm run build
`;

const STARTER_VITEST = `import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
      "server-only": path.resolve(import.meta.dirname, "tests/helpers/empty.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
`;

function presentAsTheBaLeftIt() {
  write("README.md", STARTER_README);
  write(".github/workflows/ci.yml", STARTER_CI);
  write("vitest.config.mts", STARTER_VITEST);
  remove("docs");
  remove("RELEASE_NOTES.md");
  // Only the tests the BA's AI tool wrote early on survive.
  for (const f of fs.readdirSync(abs("tests"))) if (f.endsWith(".test.ts") && f !== "normalise.test.ts") remove(`tests/${f}`);
  remove("tests/helpers/db.ts");
  const pkg = JSON.parse(read("package.json"));
  for (const s of ["db:start", "db:stop", "db:reset", "test:db"]) delete pkg.scripts[s];
  write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  edit(
    "supabase/config.toml",
    "# Local Supabase stack for the Kopano Renewal Desk.\n# The ports are deliberately non-default (553xx) so this stack can run next to another local\n# Supabase project (which uses 543xx). Start it with `npx supabase start` from this folder.\n",
    "# Local Supabase (npx supabase start), on ports 553xx.\n",
    { label: "presentation" },
  );
  edit(
    "supabase/config.toml",
    "# No SQL seed: `npm run seed` loads reference data (templates, price-plan rules) and the client's\n# files through the app's own import code, so a fresh database and production load the same way.\n",
    "# Data is loaded with `npm run seed`.\n",
    { label: "presentation" },
  );
  edit(
    "lib/supabase/admin.ts",
    "/**\n * Elevated client that bypasses RLS. Server-side scripts only (the seed). Request handlers act\n * as the signed-in user instead, so the database's own policies decide what they can touch.\n */\n",
    "/** Admin client (bypasses RLS). */\n",
    { label: "presentation" },
  );
  edit(
    "lib/supabase/browser.ts",
    "/**\n * Browser client: the project URL and the publishable key only (both public by design; RLS\n * protects the data). Used to sign in, which stores the session in cookies the server reads.\n * Never put a server key here or in any NEXT_PUBLIC_ variable.\n */\n",
    "/** Supabase client for the browser (login). */\n",
    { label: "presentation" },
  );
}
presentAsTheBaLeftIt.verify = () => {
  check(read("README.md") === STARTER_README && !exists("docs/ADR-001.md") && !exists("RELEASE_NOTES.md"), "presentation: README and docs");
  check(fs.readdirSync(abs("tests")).filter((f) => f.endsWith(".test.ts")).join() === "normalise.test.ts", "presentation: only normalise tests");
  check(!/server key|NEXT_PUBLIC_ variable/.test(read("lib/supabase/browser.ts")), "presentation: no hint in the browser client");
};

// ───────────────────────── F13: history ─────────────────────────

const COMMITS = [
  { at: "2026-09-28T08:14:00+02:00", msg: "Initial commit from create-next-app", files: ["package.json", "package-lock.json", "tsconfig.json", "next.config.ts", "postcss.config.mjs", "eslint.config.mjs", ".gitignore", "app/layout.tsx", "app/page.tsx", "app/globals.css"] },
  { at: "2026-09-28T08:41:00+02:00", msg: "Supabase client and env", files: ["lib/env.ts", "lib/supabase/", "middleware.ts", ".env.local"] },
  { at: "2026-09-28T10:05:00+02:00", msg: "Schema from the dashboard and seed from the base export", files: ["schema.sql", "supabase/", "scripts/seed.ts", "lib/import/"] },
  { at: "2026-09-28T13:32:00+02:00", msg: "Login, renewal queue and customer page", files: ["app/login/", "app/queue/", "app/customers/", "app/auth/", "lib/auth.ts", "lib/format.ts", "lib/http.ts", "lib/validation.ts", "components/ConsentButtons.tsx"] },
  { at: "2026-09-28T16:47:00+02:00", msg: "Log outcomes and queue messages", files: ["components/OutcomeForm.tsx", "components/MessageForm.tsx", "app/api/outcomes/", "app/api/messages/", "app/api/contact-points/", "lib/messaging.ts"] },
  { at: "2026-09-29T09:20:00+02:00", msg: "AI summary button (OpenRouter)", files: ["components/SummaryPanel.tsx", "app/api/summary/", "lib/summary.ts", "lib/openrouter.ts", "scripts/openrouter-stub.mjs"] },
  { at: "2026-09-29T12:58:00+02:00", msg: "Manager exceptions page and monthly import", files: ["app/manager/", "app/import/", "app/api/import/", "app/api/allocations/", "app/api/health/", "components/AllocateForm.tsx", "components/ImportForm.tsx"] },
  { at: "2026-09-29T15:10:00+02:00", msg: "Remove .env.local, add .env.example", files: [".env.example"], removeEnv: true },
  { at: "2026-09-29T16:36:00+02:00", msg: "Tests and CI", files: ["tests/", "vitest.config.mts", ".github/"] },
  { at: "2026-09-29T17:52:00+02:00", msg: "README", files: null },
];

function git(args, env = {}) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args], {
    cwd: OUT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

const ENV_LOCAL = () => `NEXT_PUBLIC_SUPABASE_URL=https://${FAKE_PROJECT}.supabase.co
OPENROUTER_API_KEY=${fakeSecret()}
OPENROUTER_MODEL=openai/gpt-4o-mini
`;

function buildHistory() {
  remove(".git");
  git(["init", "-q"]);
  const author = { GIT_AUTHOR_NAME: "Naledi Mokoena", GIT_AUTHOR_EMAIL: "naledi.ba@example.co.za", GIT_COMMITTER_NAME: "Naledi Mokoena", GIT_COMMITTER_EMAIL: "naledi.ba@example.co.za" };
  for (const c of COMMITS) {
    if (c.files?.includes(".env.local")) write(".env.local", ENV_LOCAL());
    if (c.removeEnv) {
      remove(".env.local");
      git(["rm", "-q", "--cached", "--ignore-unmatch", ".env.local"]);
    }
    if (c.files) for (const f of c.files) if (exists(f)) git(["add", "-f", "--", f]);
    if (!c.files) git(["add", "-A"]);
    git(["commit", "-q", "--allow-empty", "-m", c.msg], { ...author, GIT_AUTHOR_DATE: c.at, GIT_COMMITTER_DATE: c.at });
  }
}
buildHistory.verify = () => {
  check(!exists(".env.local"), "F13: .env.local deleted from the working tree");
  check(!git(["ls-files"]).split("\n").includes(".env.local"), "F13: .env.local not in HEAD");
  check(git(["log", "--all", "-p", "--", ".env.local"]).includes(fakeSecret()), "F13: the key is still in history");
  check(git(["status", "--porcelain"]).trim() === "", "F13: clean working tree");
  const tracked = git(["ls-files"]).split("\n");
  check(!tracked.some((f) => /(^|\/)(live-db\.sql|faults\.json)$/.test(f)), "history: no internal artefact (live-db.sql, faults.json) is committed");
  const everCommitted = git(["log", "--all", "--name-only", "--pretty=format:"]).split("\n");
  check(!everCommitted.some((f) => /(^|\/)(live-db\.sql|faults\.json)$/.test(f)), "history: no internal artefact was ever committed");
  check(Number(git(["rev-list", "--count", "HEAD"]).trim()) >= 8, "F13: several commits");
};

// ───────────────────────── Run ─────────────────────────

const FAULTS = [
  ["F01", "customers has RLS disabled", F01_customersRlsDisabled],
  ["F02", "interactions policy using (true)", F02_interactionsPolicyUsingTrue],
  ["F03", "anon grants + demo policy on lines", F03_anonDemoPolicyOnLines],
  ["F04", "service key in NEXT_PUBLIC_ used by a client component", F04_serviceKeyInClientComponent],
  ["F05", "/api/summary: no auth, no rate limit, no max tokens", F05_summaryRouteUnprotected],
  ["F06", "user text interpolated with other customers' data", F06_promptMixesUserTextAndOtherCustomers],
  ["F08", "import deletes everything, then inserts", F08_importDeletesAndReinserts],
  ["F09", "phones stored as numbers", F09_phonesStoredAsNumbers],
  ["F10", "call back without a date (UI-only check)", F10_callbackDateOnlyInUi],
  ["F11", "status from the stale export column", F11_statusFromExportColumn],
  ["F12", "opt-out list not applied to messaging", F12_optoutsNotApplied],
  ["F14", "import without error handling", F14_importWithoutErrorHandling],
  ["F07", "no migrations; schema.sql out of date", F07_noMigrationsStaleSchema],
  ["F13", ".env.local committed then deleted (part 1: .gitignore)", F13_envNotIgnored],
];

/** All SQL that defines the database at this point (migrations, or the flattened files after F07). */
function currentSql() {
  if (exists(MIG)) return fs.readdirSync(abs(MIG)).filter((f) => f.endsWith(".sql")).sort().map((f) => read(`${MIG}/${f}`)).join("\n");
  return fs.readFileSync(path.join(INTERNAL, "live-db.sql"), "utf8");
}

function main() {
  copyReference();
  fs.mkdirSync(INTERNAL, { recursive: true });
  const report = [];
  for (const [id, title, fn] of FAULTS) {
    fn();
    fn(); // idempotent: a second run must change nothing
    fn.verify(currentSql());
    report.push({ id, title, transformation: fn.name });
    console.log(`  ${id}  ${fn.name}: ok`);
  }
  presentAsTheBaLeftIt();
  presentAsTheBaLeftIt.verify();
  buildHistory();
  buildHistory.verify();
  // Everything again on the finished tree: later steps must not have undone an earlier fault.
  for (const [, , fn] of FAULTS) fn.verify(currentSql());
  console.log("  F13  buildHistory: ok (.env.local committed, then deleted)");

  fs.writeFileSync(
    path.join(INTERNAL, "faults.json"),
    `${JSON.stringify({ built_at: new Date().toISOString(), starter: OUT, head: git(["rev-parse", "HEAD"]).trim(), f13: { file: ".env.local", variable: "OPENROUTER_API_KEY", planted_value: fakeSecret(), introduced_in: COMMITS[1].msg, removed_in: COMMITS[7].msg }, faults: report }, null, 2)}\n`,
  );
  console.log(`\nStarter: ${OUT} (${git(["rev-list", "--count", "HEAD"]).trim()} commits)`);
  console.log(`Internal: ${INTERNAL}/live-db.sql, faults.json (never share)`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof FaultError ? `make-starter: ${err.message}` : err);
  process.exit(1);
}
