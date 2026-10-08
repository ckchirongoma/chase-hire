/**
 * Fake SWE Test 1 deployments for the harness integration test (tests/integration/harness.test.ts).
 *
 * Options: keyInBundle=false emulates an app that keeps Supabase server-side (no publishable key
 * in any chunk; the harness signs in through the login form, a Next.js-style progressive
 * enhancement form that sets the @supabase/ssr cookie). The bad app's import runs in the
 * background ("Import started"), so the harness has to wait for it to settle.
 *
 * startFakeTarget("good") emulates a hardened Kopano Renewal Desk; startFakeTarget("bad") the
 * planted-fault starter (F01–F05, F08–F12, F14). Each is two local HTTP servers:
 *   app      the Next.js app: pages + JS chunks, /api/health, /api/summary, /api/outcomes,
 *            /api/messages, /api/import, /customers/:id, and a fake MDN Observatory.
 *   supabase a tiny PostgREST (/rest/v1) + GoTrue (/auth/v1) over the same in-memory DB, with
 *            or without RLS-like isolation.
 * The "xlsx" files are JSON in disguise: the harness uploads bytes as given, and the fake app
 * decodes them. Every key, token and password is generated at run time (nothing secret-looking
 * is committed).
 */
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { HarnessExpected } from "@/lib/harness/expected";

export type Mode = "good" | "bad";
type Row = Record<string, unknown>;

const rand = (n = 12) => randomBytes(n).toString("hex");
const b64url = (s: string) => Buffer.from(s).toString("base64url");
/** A JWT-shaped token with the given claims and a random (meaningless) signature. */
export const fakeJwt = (claims: Row) => `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}.${randomBytes(32).toString("base64url")}`;

// ───────────────────────── Fixture data ─────────────────────────

const C = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
interface Seed {
  customers: Row[];
  lines: Row[];
}

function seed(): Seed {
  const cust = (n: number, legal_name: string, reg_no: string) => ({ id: C(n), legal_name, normalised_name: legal_name.replace(/\s*\(PTY\) LTD$|\s+CC$/, ""), reg_no, segment: "SME", created_at: "2026-10-07T00:00:00Z" });
  const customers = [
    cust(1, "UBUNTU LOGISTICS (PTY) LTD", "2015/100001/07"),
    cust(2, "MARULA MOTORS CC", "2016/100002/23"),
    cust(3, "KUDU ENGINEERING (PTY) LTD", "2017/100003/07"),
    cust(4, "PROTEA CATERING (PTY) LTD", "2018/100004/07"),
    cust(5, "LESEDI HOLDINGS (PTY) LTD", "2019/100005/07"),
    cust(6, "BAOBAB TRANSPORT CC", "2019/100006/23"),
    cust(7, "FYNBOS PRINTING (PTY) LTD", "2020/100007/07"),
    cust(8, "IMPALA SECURITY (PTY) LTD", "2020/100008/07"),
  ];
  const line = (n: number, c: number, msisdn: string, priceplan: string, end: string, type = "mobile") => ({
    id: C(100 + n),
    customer_id: C(c),
    msisdn_e164: msisdn,
    priceplan,
    contract_end_date: end,
    contract_status: deriveStatus(end),
    line_type: type,
    active: true,
    ported_out_at: null,
  });
  const lines = [
    line(1, 1, "+27821000001", "BZT100", "2027-03-31"),
    line(2, 1, "+27821000002", "BZS2G", "2026-12-31"),
    line(3, 2, "+27831000003", "BZT250", "2027-06-30"),
    line(4, 3, "+27841000004", "BZD10G", "2026-01-31"),
    line(5, 4, "+27721000005", "BZT600", "2027-01-31"),
    line(6, 4, "+27721000006", "BZT100", "2027-02-28"),
    line(7, 5, "+27731000007", "BZS6G", "2027-04-30"),
    line(8, 6, "+27741000008", "BZT100", "2027-05-31"),
    line(9, 7, "+27111000009", "BZT100", "2026-02-28", "landline"),
    line(10, 8, "+27611000010", "BZS15G", "2027-08-31"),
  ];
  return { customers, lines };
}

function deriveStatus(end: string): string {
  return end < new Date().toISOString().slice(0, 10) ? "OutOfContract" : "InContract";
}

interface FileRow {
  reg_no: string;
  name: string;
  msisdn: string;
  priceplan: string;
  end: string;
  status: string;
}

const ROWS: FileRow[] = [
  { reg_no: "2015/100001/07", name: "UBUNTU LOGISTICS (PTY) LTD", msisdn: "0821000001", priceplan: "BZS6G", end: "2027-03-31", status: "InContract" }, // 2 changed plan
  { reg_no: "2015/100001/07", name: "UBUNTU LOGISTICS (PTY) LTD", msisdn: "821000002", priceplan: "BZS2G", end: "2026-12-31", status: "InContract" }, // 3
  { reg_no: "2016/100002/23", name: "MARULA MOTORS CC", msisdn: "831000003", priceplan: "BZT250", end: "2027-06-30", status: "InContract" }, // 4
  { reg_no: "2017/100003/07", name: "KUDU ENGINEERING (PTY) LTD", msisdn: "841000004", priceplan: "BZD10G", end: "2028-11-07", status: "InContract" }, // 5 changed end
  { reg_no: "2018/100004/07", name: "PROTEA CATERING (PTY) LTD", msisdn: "721000005", priceplan: "BZT600", end: "05/06/2027", status: "InContract" }, // 6 ambiguous
  { reg_no: "2019/100005/07", name: "LESEDI HOLDINGS (PTY) LTD", msisdn: "731000007", priceplan: "BZS6G", end: "2027-04-30", status: "InContract" }, // 7
  { reg_no: "2019/100006/23", name: "BAOBAB TRANSPORT CC", msisdn: "+27 74 100 0008", priceplan: "BZT100", end: "2027-05-31", status: "InContract" }, // 8 new spelling
  { reg_no: "2020/100007/07", name: "FYNBOS PRINTING (PTY) LTD", msisdn: "111000009", priceplan: "BZT100", end: "2026-02-28", status: "InContract" }, // 9 stale status
  { reg_no: "2020/100008/07", name: "IMPALA SECURITY (PTY) LTD", msisdn: "611000010", priceplan: "BZS15G", end: "2027-08-31", status: "InContract" }, // 10
  { reg_no: "2015/100001/07", name: "UBUNTU LOGISTICS (PTY) LTD", msisdn: "0821000001", priceplan: "BZS6G", end: "2027-03-31", status: "InContract" }, // 11 duplicate of 2
  { reg_no: "2024/100009/07", name: "IMBALI BAKERY (PTY) LTD", msisdn: "821000011", priceplan: "BZT250", end: "2028-09-30", status: "InContract" }, // 12 new customer
  { reg_no: "2024/100009/07", name: "IMBALI BAKERY (PTY) LTD", msisdn: "821000012", priceplan: "BZT250", end: "2028-09-30", status: "InContract" }, // 13
  { reg_no: "2024/100010/23", name: "VUKANI ROOFING CC", msisdn: "831000013", priceplan: "BZS2G", end: "2028-10-31", status: "InContract" }, // 14 new customer
  { reg_no: "2015/100001/07", name: "UBUNTU LOGISTICS (PTY) LTD", msisdn: "821000014", priceplan: "BZT100", end: "2028-12-31", status: "InContract" }, // 15 new line, existing customer
  { reg_no: "2020/100008/07", name: "IMPALA SECURITY (PTY) LTD", msisdn: "0", priceplan: "BZT100", end: "2027-08-31", status: "InContract" }, // 16 invalid phone
  { reg_no: "2020/100008/07", name: "IMPALA SECURITY (PTY) LTD", msisdn: "611000015", priceplan: "BZT100", end: "1970-01-01", status: "InContract" }, // 17 epoch
];
const HEADERS = ["Account No", "Reg No", "Customer Name", "Msisdn", "Contract End Date", "Contract Status", "Priceplan"];
const DRIFT_HEADERS = ["Account No", "Reg No", "Customer Name", "Msisdn", "Contract_End", "Contract Status", "Priceplan", "Sales_Rep"];

export const fixtureFiles = () => ({
  month2: Buffer.from(JSON.stringify({ kind: "month2", headers: HEADERS, rows: ROWS })),
  drift: Buffer.from(JSON.stringify({ kind: "drift", headers: DRIFT_HEADERS, rows: ROWS })),
});

export const fixtureExpected = (): HarnessExpected => ({
  bundle: "bundle_c",
  version: "test",
  seed: 1,
  month1: { customers: 8, lines: 10 },
  month2: {
    file_rows: ROWS.length,
    customers_after: 10,
    new_customers: 2,
    new_customer_accounts: [],
    lines_after_active: 13,
    lines_new: 4,
    lines_new_for_existing_customers: 1,
    lines_changed: 2,
    lines_removed: 1,
    duplicate_rows: 1,
    phone_defect_rows: 1,
    ambiguous_date_rows: 1,
    changed: [
      { msisdn_e164: "+27821000001", field: "Priceplan", from: "BZT100", to: "BZS6G" },
      { msisdn_e164: "+27841000004", field: "Contract End Date", from: "2026-01-31", to: "2028-11-07" },
    ],
    removed_msisdns: ["+27721000006"],
    new_msisdns: ["+27821000011", "+27821000012", "+27831000013", "+27821000014"],
    quarantine_expected: [
      { row: 6, reason: "ambiguous_date" },
      { row: 16, reason: "invalid_phone" },
      { row: 17, reason: "epoch_date" },
    ],
  },
  drift: { file: "base_month2_drift.xlsx", renamed: { from: "Contract End Date", to: "Contract_End" }, added: ["Sales_Rep"] },
  sentinels: [
    { account_no: 5005, account_nos: [5005], reg_no: "2019/100005/07", name: "LESEDI HOLDINGS (PTY) LTD", lines: 1, msisdns: ["+27731000007"] },
    { account_no: 6006, account_nos: [6006], reg_no: "2019/100006/23", name: "BAOBAB TRANSPORT CC", lines: 1, msisdns: ["+27741000008"] },
  ],
  optouts: { listed: 2, matches: [{ listed_name: "Marula Motors", status: "Opted out", customer_reg_no: "2016/100002/23", account_nos: [2002] }], not_customers: [] },
});

// ───────────────────────── In-memory DB ─────────────────────────

interface User {
  id: string;
  email: string;
  password: string;
  role: "agent" | "manager";
}

interface Db {
  customers: Row[];
  lines: Row[];
  allocations: Row[];
  interactions: Row[];
  optouts: Row[];
  templates: Row[];
  message_queue: Row[];
  import_runs: Row[];
  quarantine_rows: Row[];
  agents: Row[];
}

function normaliseMsisdn(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  if (/^0\d{9}$/.test(d)) return `+27${d.slice(1)}`;
  if (/^27\d{9}$/.test(d)) return `+${d}`;
  if (/^\d{9}$/.test(d)) return `+27${d}`;
  return null;
}

// ───────────────────────── Servers ─────────────────────────

export interface FakeOptions {
  /** false: no publishable key in the front end (the app keeps Supabase server-side). Default true. */
  keyInBundle?: boolean;
  /**
   * /api/messages refuses every request with a validation error (so it never reaches the opt-out
   * rule), and agents may not insert into message_queue at all: a refusal that proves nothing.
   */
  messagesRejectAll?: boolean;
  /** The "Supabase" host is some gateway: no /auth/v1/settings, every REST call a bare 401. */
  opaqueSupabase?: boolean;
  /** No /api/import route (renamed). */
  noImportRoute?: boolean;
}

export interface FakeTarget {
  mode: Mode;
  /** The project's publishable key (to hand to the harness as a candidate would). */
  publishableKey: string;
  appUrl: string;
  supabaseUrl: string;
  observatoryUrl: string;
  testLogins: string;
  users: { a: User; b: User; manager: User };
  db: Db;
  counters: { summaryCalls: number; imports: number };
  close(): Promise<void>;
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json", ...headers });
  res.end(text);
}

/** The text fields of a multipart/form-data body. */
function multipartFields(body: Buffer, contentType: string): Map<string, string> {
  const out = new Map<string, string>();
  const m = contentType.match(/boundary=([^;]+)/);
  if (!m) return out;
  for (const part of body.toString("utf8").split(`--${m[1]}`)) {
    const name = part.match(/name="([^"]*)"/)?.[1];
    const start = part.indexOf("\r\n\r\n");
    if (name !== undefined && start >= 0) out.set(name, part.slice(start + 4, part.lastIndexOf("\r\n")));
  }
  return out;
}

/** The login page's form as Next.js renders a server action for browsers without JavaScript. */
const LOGIN_FORM = `<form class="card" action="" encType="multipart/form-data" method="POST"><input type="hidden" name="$ACTION_REF_1"/><input type="hidden" name="$ACTION_1:0" value="{&quot;id&quot;:&quot;6081&quot;,&quot;bound&quot;:&quot;$@1&quot;}"/><input type="hidden" name="$ACTION_KEY" value="k-fake-action"/><label for="email">Email</label><input id="email" type="email" autoComplete="username" required="" name="email"/><label for="password">Password</label><input id="password" type="password" required="" name="password"/><button type="submit">Sign in</button></form>`;

/** The file part of a multipart/form-data body. */
function multipartFile(body: Buffer, contentType: string): Buffer | null {
  const m = contentType.match(/boundary=([^;]+)/);
  if (!m) return null;
  const parts = body.toString("latin1").split(`--${m[1]}`);
  for (const p of parts) {
    if (!/name="file"/.test(p)) continue;
    const start = p.indexOf("\r\n\r\n");
    return Buffer.from(p.slice(start + 4, p.lastIndexOf("\r\n")), "latin1");
  }
  return null;
}

export async function startFakeTarget(mode: Mode, opts: FakeOptions = {}): Promise<FakeTarget> {
  const good = mode === "good";
  const keyInBundle = opts.keyInBundle ?? true;
  const s = seed();
  const users = {
    a: { id: randomUUID(), email: `agent.a.${rand(3)}@example.co.za`, password: `pw-${rand(6)}`, role: "agent" as const },
    b: { id: randomUUID(), email: `agent.b.${rand(3)}@example.co.za`, password: `pw-${rand(6)}`, role: "agent" as const },
    manager: { id: randomUUID(), email: `manager.${rand(3)}@example.co.za`, password: `pw-${rand(6)}`, role: "manager" as const },
  };
  const all = [users.a, users.b, users.manager];
  const db: Db = {
    customers: s.customers,
    lines: s.lines,
    allocations: [
      { id: randomUUID(), customer_id: C(1), agent_id: users.a.id },
      { id: randomUUID(), customer_id: C(2), agent_id: users.a.id },
      { id: randomUUID(), customer_id: C(3), agent_id: users.b.id },
      { id: randomUUID(), customer_id: C(4), agent_id: users.b.id },
    ],
    interactions: [{ id: randomUUID(), customer_id: C(3), agent_id: users.b.id, outcome: "quote", next_action_at: null, notes: "B's own call", created_at: "2026-10-01T09:00:00Z" }],
    optouts: [{ id: randomUUID(), company_name: "Marula Motors", normalised_name: "MARULA MOTORS", customer_id: C(2), reason: "Complaint", created_at: "2026-09-01T00:00:00Z" }],
    templates: [{ id: randomUUID(), name: "Renewal reminder", category: "utility", body: "Your contract ends soon", approved: true }],
    message_queue: [],
    import_runs: [],
    quarantine_rows: [],
    agents: all.map((u) => ({ id: u.id, name: u.email, role: u.role })),
  };
  const publishable = `sb_publishable_${rand(16)}`;
  const tokens = new Map<string, User>();
  const counters = { summaryCalls: 0, imports: 0 };
  const summaryLimit = new Map<string, number>();

  const isManager = (u: User | null) => u?.role === "manager";
  const allocatedTo = (u: User) => db.allocations.filter((a) => a.agent_id === u.id).map((a) => a.customer_id as string);
  const canSeeCustomer = (u: User, id: string) => isManager(u) || allocatedTo(u).includes(id);
  const optedOut = (customerId: string) => db.optouts.some((o) => o.customer_id === customerId);

  // ── Supabase emulation ──
  const tableVisible = (table: keyof Db, u: User | null): Row[] => {
    const rows = db[table];
    if (!good) {
      // F01/F03: anon reads customers and lines; F02: any signed-in user reads every interaction.
      if (!u) return table === "customers" || table === "lines" ? rows : [];
      return rows;
    }
    if (!u) return [];
    if (isManager(u)) return rows;
    const mine = allocatedTo(u);
    switch (table) {
      case "customers":
        return rows.filter((r) => mine.includes(r.id as string));
      case "lines":
      case "message_queue":
        return rows.filter((r) => mine.includes(r.customer_id as string));
      case "allocations":
      case "interactions":
        return rows.filter((r) => r.agent_id === u.id);
      case "templates":
      case "optouts":
        return rows;
      default:
        return [];
    }
  };

  function filterRows(rows: Row[], params: URLSearchParams): Row[] | { error: string } {
    let out = rows;
    for (const [k, v] of params) {
      if (["select", "limit", "offset", "order"].includes(k)) continue;
      const m = v.match(/^(eq|neq|lt|lte|gt|gte|in|is|ilike|like)\.(.*)$/s);
      if (!m) return { error: `bad filter ${k}` };
      const [, op, raw] = m;
      const val = raw;
      out = out.filter((r) => {
        const x = r[k];
        const xs = x === null || x === undefined ? null : String(x);
        switch (op) {
          case "eq":
            return xs === val;
          case "neq":
            return xs !== val;
          case "lt":
            return xs !== null && xs < val;
          case "lte":
            return xs !== null && xs <= val;
          case "gt":
            return xs !== null && xs > val;
          case "gte":
            return xs !== null && xs >= val;
          case "is":
            return val === "null" ? x === null || x === undefined : val === "true" ? x === true : x === false;
          case "in": {
            const list = [...val.slice(1, -1).matchAll(/"((?:[^"\\]|\\.)*)"|([^,]+)/g)].map((mm) => (mm[1] ?? mm[2]).replace(/\\(.)/g, "$1"));
            return xs !== null && list.includes(xs);
          }
          case "ilike":
          case "like": {
            const re = new RegExp(`^${val.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, op === "ilike" ? "i" : "");
            return xs !== null && re.test(xs);
          }
        }
        return true;
      });
    }
    const order = params.get("order");
    if (order) {
      const [col, dir] = order.split(".");
      out = [...out].sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (dir === "desc" ? -1 : 1));
    }
    return out;
  }

  const project = (rows: Row[], select: string | null) => {
    if (!select || select === "*") return rows;
    const cols = select.split(",").map((c) => c.trim());
    return rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
  };

  function restInsert(table: keyof Db, u: User | null, body: Row): { status: number; body: unknown } {
    if (!good) {
      if (!u) return table === "customers" ? { status: 400, body: { code: "23502", message: 'null value in column "legal_name" violates not-null constraint' } } : { status: 401, body: { code: "42501", message: "permission denied" } };
      const row = { id: randomUUID(), created_at: new Date().toISOString(), ...body };
      db[table].push(row);
      return { status: 201, body: [row] };
    }
    if (!u) return { status: 401, body: { code: "42501", message: `permission denied for table ${table}` } };
    if (table === "interactions") {
      if (!isManager(u) && body.agent_id !== u.id) return { status: 403, body: { code: "42501", message: "new row violates row-level security policy" } };
      if (!canSeeCustomer(u, String(body.customer_id))) return { status: 403, body: { code: "42501", message: "new row violates row-level security policy" } };
      if (body.outcome === "call_back" && !body.next_action_at) return { status: 400, body: { code: "23514", message: 'new row violates check constraint "call_back_needs_date"' } };
      const row = { id: randomUUID(), next_action_at: null, created_at: new Date().toISOString(), ...body };
      db.interactions.push(row);
      return { status: 201, body: [row] };
    }
    if (table === "message_queue") {
      if (opts.messagesRejectAll && !isManager(u)) return { status: 403, body: { code: "42501", message: "permission denied for table message_queue" } };
      if (!canSeeCustomer(u, String(body.customer_id))) return { status: 403, body: { code: "42501", message: "new row violates row-level security policy" } };
      if (optedOut(String(body.customer_id))) return { status: 400, body: { code: "P0001", message: "customer is on the opt-out list" } };
      const row = { id: randomUUID(), created_at: new Date().toISOString(), ...body };
      db.message_queue.push(row);
      return { status: 201, body: [row] };
    }
    return { status: 403, body: { code: "42501", message: "new row violates row-level security policy" } };
  }

  const userFromBearer = (h: string | undefined): User | null | "invalid" => {
    const t = h?.replace(/^Bearer\s+/i, "");
    if (!t || t === publishable) return null;
    return tokens.get(t) ?? "invalid";
  };

  const supabase = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const body = await readBody(req);
    if (req.headers.apikey !== publishable) return send(res, 401, { message: "Invalid API key" });
    if (opts.opaqueSupabase && url.pathname !== "/auth/v1/token") return send(res, 401, { message: "Unauthorized" });
    if (url.pathname === "/auth/v1/settings") return send(res, 200, { external: { email: true }, disable_signup: true });
    if (url.pathname === "/auth/v1/token" && req.method === "POST") {
      const j = JSON.parse(body.toString() || "{}") as { email?: string; password?: string };
      const u = all.find((x) => x.email === j.email && x.password === j.password);
      if (!u) return send(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials" });
      const token = `tok-${rand(24)}`;
      tokens.set(token, u);
      // Padding in user_metadata pushes the session cookie over 3180 chars (chunked cookies).
      return send(res, 200, { access_token: token, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: rand(12), user: { id: u.id, email: u.email, role: "authenticated", user_metadata: { pad: "x".repeat(3000) } } });
    }
    const m = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!m) return send(res, 404, { message: "not found" });
    const table = m[1] as keyof Db;
    if (!(table in db)) return send(res, 404, { code: "PGRST205", message: `Could not find the table 'public.${table}'` });
    const u = userFromBearer(req.headers.authorization);
    if (u === "invalid") return send(res, 401, { code: "PGRST301", message: "JWT invalid" });
    if (req.method === "GET") {
      if (good && !u && table === "lines") return send(res, 401, { code: "42501", message: "permission denied for table lines" });
      const filtered = filterRows(tableVisible(table, u), url.searchParams);
      if ("error" in filtered) return send(res, 400, { code: "PGRST100", message: filtered.error });
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      const page = filtered.slice(offset, offset + limit);
      const prefer = String(req.headers.prefer ?? "");
      const headers: Record<string, string> = {};
      if (prefer.includes("count=exact")) headers["content-range"] = page.length ? `${offset}-${offset + page.length - 1}/${filtered.length}` : `*/${filtered.length}`;
      return send(res, 200, project(page, url.searchParams.get("select")), headers);
    }
    if (req.method === "POST") {
      const j = JSON.parse(body.toString() || "{}") as Row;
      const r = restInsert(table, u, j);
      const prefer = String(req.headers.prefer ?? "");
      if (r.status === 201 && prefer.includes("return=minimal")) {
        res.writeHead(201);
        return res.end();
      }
      return send(res, r.status, r.body);
    }
    return send(res, 405, { message: "method not allowed" });
  });
  const supabaseUrl = await listen(supabase);

  // ── App ──
  const sessionUser = (req: http.IncomingMessage): User | null => {
    const fromBearer = userFromBearer(req.headers.authorization);
    if (fromBearer && fromBearer !== "invalid") return fromBearer;
    const cookies = Object.fromEntries(
      String(req.headers.cookie ?? "")
        .split(/;\s*/)
        .filter(Boolean)
        .map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]),
    );
    const name = "sb-127-auth-token";
    let value = cookies[name];
    if (!value) {
      const parts: string[] = [];
      for (let i = 0; cookies[`${name}.${i}`]; i++) parts.push(cookies[`${name}.${i}`]);
      value = parts.join("");
    }
    if (!value?.startsWith("base64-")) return null;
    try {
      const session = JSON.parse(Buffer.from(value.slice(7), "base64url").toString("utf8")) as { access_token?: string };
      return tokens.get(String(session.access_token)) ?? null;
    } catch {
      return null;
    }
  };

  const serviceJwt = fakeJwt({ iss: "supabase-test", role: "service_role", ref: "fakeproject" });
  const anonJwt = fakeJwt({ iss: "supabase-test", role: "anon", ref: "fakeproject" });
  const chunks: Record<string, string> = {
    "/_next/static/chunks/main-app.js": `(()=>{console.log("app shell");var t=${JSON.stringify(anonJwt.slice(0, 8))};})();`,
    "/_next/static/chunks/app/login/page.js": keyInBundle
      ? `(self.webpackChunk=self.webpackChunk||[]).push([[1],{9:(e,t,n)=>{let a=(0,n.createBrowserClient)("${supabaseUrl}","${publishable}");fetch("https://openrouter.ai/api/v1")}}]);`
      : `(self.webpackChunk=self.webpackChunk||[]).push([[1],{9:(e,t,n)=>{let a="sign in";fetch("https://a")}}]);`,
    "/_next/static/chunks/app/queue/page.js": `(self.webpackChunk=self.webpackChunk||[]).push([[2],{3:()=>{let q="renewal queue"}}]);`,
    // F04: the service-role key shipped in a client component (only on a signed-in page).
    "/_next/static/chunks/app/queue/admin-panel.js": `(self.webpackChunk=self.webpackChunk||[]).push([[3],{4:()=>{let k="${serviceJwt}"}}]);`,
  };
  const page = (title: string, scripts: string[], extra = "") =>
    `<!doctype html><html><head><title>${title}</title>${scripts.map((s) => `<script src="${s}" async></script>`).join("")}</head><body><a href="/login">Log in</a><a href="/queue">Queue</a>${extra}<script>self.__next_f.push([1,"0:[\\"$\\",\\"script\\",{\\"src\\":\\"\\/_next\\/static\\/chunks\\/main-app.js\\"}]"])</script></body></html>`;

  const app = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const body = await readBody(req);
    const u = sessionUser(req);
    const json = () => JSON.parse(body.toString() || "{}") as Row;
    const p = url.pathname;
    if (chunks[p]) return send(res, 200, chunks[p], { "content-type": "application/javascript" });
    if (req.method === "GET" && p === "/") return send(res, 200, page("Kopano Renewal Desk", ["/_next/static/chunks/main-app.js"]));
    if (req.method === "GET" && p === "/login") return send(res, 200, page("Log in", ["/_next/static/chunks/main-app.js", "/_next/static/chunks/app/login/page.js"], LOGIN_FORM));
    if (req.method === "POST" && p === "/login") {
      // A server action submitted without JavaScript: multipart, hidden $ACTION fields, Origin checked.
      const fields = multipartFields(body, String(req.headers["content-type"] ?? ""));
      if (fields.get("$ACTION_KEY") !== "k-fake-action" || req.headers.origin !== appUrl) return send(res, 400, "<html>Bad action</html>");
      const user = all.find((x) => x.email === fields.get("email") && x.password === fields.get("password"));
      if (!user) return send(res, 200, page("Log in", [], `<p class="error">That email and password do not match.</p>${LOGIN_FORM}`));
      const token = `tok-${rand(24)}`;
      tokens.set(token, user);
      // @supabase/ssr: "base64-" + base64url(session JSON), chunked into .0/.1 above 3180 characters.
      const value = `base64-${Buffer.from(JSON.stringify({ access_token: token, token_type: "bearer", refresh_token: rand(12), user: { id: user.id, email: user.email, user_metadata: { pad: "x".repeat(3000) } } })).toString("base64url")}`;
      const cookies = [];
      for (let i = 0, n = 0; i < value.length; i += 3180, n++) cookies.push(`sb-127-auth-token.${n}=${value.slice(i, i + 3180)}; Path=/; HttpOnly; SameSite=Lax`);
      res.writeHead(303, { location: "/queue", "set-cookie": [...cookies, "stale=1; Path=/; Max-Age=0"] });
      return res.end();
    }
    if (req.method === "GET" && p === "/queue") {
      if (!u) return send(res, 307, "", { location: "/login" });
      // The queue lists the caller's own customers (manager: everyone), linked to their pages.
      const mine = isManager(u) ? db.customers : db.customers.filter((c) => allocatedTo(u).includes(c.id as string));
      const rows = mine.map((c) => `<tr><td><a href="/customers/${String(c.id)}">${String(c.legal_name).replace(/&/g, "&amp;")}</a></td></tr>`).join("");
      return send(res, 200, page("Queue", ["/_next/static/chunks/main-app.js", "/_next/static/chunks/app/queue/page.js", ...(good ? [] : ["/_next/static/chunks/app/queue/admin-panel.js"])], `<table>${rows}</table>`));
    }
    const cm = p.match(/^\/customers\/([0-9a-f-]{36})$/);
    if (req.method === "GET" && cm) {
      if (!u) return send(res, 307, "", { location: "/login" });
      const c = db.customers.find((x) => x.id === cm[1]);
      if (!c || (good && !canSeeCustomer(u, cm[1]))) return send(res, 404, "<html>Not found</html>");
      // The message form as React renders it (text split by <!-- --> markers), plus the RSC props.
      const options = db.templates.map((t) => `<option value="${String(t.id)}">${String(t.name)}<!-- --> (<!-- -->${String(t.category)}<!-- -->)</option>`).join("");
      const props = JSON.stringify({ customerId: c.id, templates: db.templates.map((t) => ({ id: t.id, name: t.name, category: t.category, body: t.body })) }).replace(/"/g, '\\"');
      return send(res, 200, `<html><body><h1>${String(c.legal_name)}</h1><select class="input">${options}</select><script>self.__next_f.push([1,"5:[\\"$\\",\\"$L6\\",null,${props}]"])</script></body></html>`);
    }
    if (req.method === "GET" && p === "/api/health") return send(res, 200, good ? { ok: true, db: "ok" } : { ok: true });
    if (req.method === "POST" && p === "/__observatory/api/v2/scan") return send(res, 200, { id: 1, grade: good ? "B+" : "F", score: good ? 80 : 0, tests_passed: good ? 9 : 3, tests_failed: good ? 1 : 7, tests_quantity: 10, details_url: "https://developer.mozilla.org/en-US/observatory/analyze?host=example", scanned_at: new Date().toISOString() });

    if (req.method === "POST" && p === "/api/summary") {
      if (good) {
        if (!u) return send(res, 401, { error: "Not signed in" });
        const n = (summaryLimit.get(u.id) ?? 0) + 1;
        summaryLimit.set(u.id, n);
        if (n > 5) return send(res, 429, { error: "Too many summaries: try again in a minute" });
        if (!canSeeCustomer(u, String(json().customerId))) return send(res, 403, { error: "Not your customer" });
      }
      counters.summaryCalls++;
      return send(res, 200, { summary: "Customer is due for renewal." });
    }
    if (req.method === "POST" && p === "/api/outcomes") {
      if (!u) return send(res, 401, { error: "Not signed in" });
      const j = json();
      if (good) {
        if (!canSeeCustomer(u, String(j.customerId))) return send(res, 403, { error: "Not your customer" });
        if (j.outcome === "call_back" && !j.nextActionAt) return send(res, 422, { error: "A call back needs a callback date (nextActionAt)" });
      }
      const row = { id: randomUUID(), customer_id: j.customerId, agent_id: u.id, outcome: j.outcome, next_action_at: j.nextActionAt ?? null, notes: j.notes ?? null, created_at: new Date().toISOString() };
      db.interactions.push(row);
      return send(res, 201, row);
    }
    if (req.method === "POST" && p === "/api/messages") {
      if (!u) return send(res, 401, { error: "Not signed in" });
      const j = json();
      if (opts.messagesRejectAll) return send(res, 400, { error: "Invalid request: field 'template' is required" });
      if (good) {
        if (!canSeeCustomer(u, String(j.customerId))) return send(res, 403, { error: "Not your customer" });
        if (optedOut(String(j.customerId))) return send(res, 409, { error: "This customer is on the legal opt-out list: no messages." });
      }
      const row = { id: randomUUID(), customer_id: j.customerId, template_id: j.templateId, status: "queued", created_by: u.id, created_at: new Date().toISOString() };
      db.message_queue.push(row);
      return send(res, 201, row);
    }
    if (req.method === "POST" && p === "/api/import" && !opts.noImportRoute) {
      if (!u) return send(res, 401, { error: "Not signed in" });
      if (good && !isManager(u)) return send(res, 403, { error: "Managers only" });
      const file = multipartFile(body, String(req.headers["content-type"] ?? ""));
      if (!file) return send(res, 400, { error: "No file" });
      counters.imports++;
      const doc = JSON.parse(file.toString("utf8")) as { headers: string[]; rows: FileRow[] };
      if (good) return goodImport(doc, res);
      // F14: the import "starts" and runs in the background, failing silently.
      setTimeout(() => badImport(doc), 20);
      return send(res, 200, { ok: true, message: "Import started. Refresh the queue in a minute." });
    }
    return send(res, 404, "<html>404</html>");
  });

  function goodImport(doc: { headers: string[]; rows: FileRow[] }, res: http.ServerResponse) {
    const missing = HEADERS.filter((h) => !doc.headers.includes(h));
    const extra = doc.headers.filter((h) => !HEADERS.includes(h));
    if (missing.length || extra.length) return send(res, 422, { error: `File structure changed: missing column(s) ${missing.map((m) => `"${m}"`).join(", ")}; unexpected column(s) ${extra.map((m) => `"${m}"`).join(", ")}. Nothing was imported.` });
    const run = { id: randomUUID(), file_name: "upload.xlsx", status: "done", counts: {}, created_at: new Date().toISOString() };
    db.import_runs.push(run);
    const quarantined: { row_number: number; reason: string }[] = [];
    const seen = new Set<string>();
    doc.rows.forEach((r, i) => {
      const rowNumber = i + 2;
      const msisdn = normaliseMsisdn(r.msisdn);
      if (msisdn) seen.add(msisdn);
      const dm = r.end.match(/^(\d\d)\/(\d\d)\/(\d{4})$/);
      if (dm && Number(dm[1]) <= 12 && Number(dm[2]) <= 12) return quarantined.push({ row_number: rowNumber, reason: "ambiguous_date" });
      if (!msisdn) return quarantined.push({ row_number: rowNumber, reason: "invalid_phone" });
      if (r.end.startsWith("1970-")) return quarantined.push({ row_number: rowNumber, reason: "epoch_date" });
      let c = db.customers.find((x) => x.reg_no === r.reg_no);
      if (!c) {
        c = { id: randomUUID(), legal_name: r.name, normalised_name: r.name.replace(/\s*\(PTY\) LTD$|\s+CC$/, ""), reg_no: r.reg_no, segment: "SME", created_at: new Date().toISOString() };
        db.customers.push(c);
      }
      const status = deriveStatus(r.end);
      const line = db.lines.find((l) => l.msisdn_e164 === msisdn);
      if (line) {
        if (line.priceplan !== r.priceplan) line.priceplan = r.priceplan;
        if (line.contract_end_date !== r.end) line.contract_end_date = r.end;
        if (line.contract_status !== status) line.contract_status = status;
        if (line.active !== true) Object.assign(line, { active: true, ported_out_at: null });
      } else {
        db.lines.push({ id: randomUUID(), customer_id: c.id, msisdn_e164: msisdn, priceplan: r.priceplan, contract_end_date: r.end, contract_status: status, line_type: /^\+27[1-5]/.test(msisdn) ? "landline" : "mobile", active: true, ported_out_at: null });
      }
    });
    for (const l of db.lines) if (l.active === true && !seen.has(String(l.msisdn_e164))) Object.assign(l, { active: false, ported_out_at: new Date().toISOString(), contract_status: "PortedOut" });
    for (const q of quarantined) db.quarantine_rows.push({ id: randomUUID(), import_run_id: run.id, row_number: q.row_number, reason: q.reason, raw: {} });
    return send(res, 200, { run_id: run.id, quarantined });
  }

  // F08 (delete all, insert again: new IDs, orphaned history), F09 (phones as numbers),
  // F11 (stale status copied), F14 (no validation; a bad file crashes half-way).
  function badImport(doc: { headers: string[]; rows: FileRow[] }) {
    db.customers.length = 0;
    db.lines.length = 0;
    db.allocations.length = 0;
    for (const r of doc.rows) {
      const c = { id: randomUUID(), legal_name: r.name, normalised_name: r.name, reg_no: r.reg_no, segment: "SME", created_at: new Date().toISOString() };
      db.customers.push(c);
      db.lines.push({ id: randomUUID(), customer_id: c.id, msisdn_e164: Number(r.msisdn.replace(/\D/g, "")), priceplan: r.priceplan, contract_end_date: r.end, contract_status: r.status, active: true, ported_out_at: null });
    }
    // The renamed column is never noticed: end dates just go missing (F14, silently).
    if (!doc.headers.includes("Contract End Date")) for (const l of db.lines) l.contract_end_date = null;
  }

  const appUrl = await listen(app);
  return {
    mode,
    publishableKey: publishable,
    appUrl,
    supabaseUrl,
    observatoryUrl: `${appUrl}/__observatory`,
    // Slightly messy on purpose: bullets, markdown and a manager heading line.
    testLogins: `- **Agent A**: ${users.a.email} / ${users.a.password}\n- Agent B: \`${users.b.email}\` / ${users.b.password}\n\nManager\n  Email: ${users.manager.email}\n  Password: ${users.manager.password}\n`,
    users,
    db,
    counters,
    async close() {
      await Promise.all([new Promise((r) => app.close(r)), new Promise((r) => supabase.close(r))]);
    },
  };
}
