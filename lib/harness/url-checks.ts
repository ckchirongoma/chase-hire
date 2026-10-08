import "server-only";
import { fail, inconclusive, informational, pass, snippet, type CheckKey, type CheckResult, type Evidence } from "./checks";
import { matchOptouts, type CustomerLite, type OptoutEntry } from "./expected";
import { crawlAuthenticated, crawlPublic, findSupabase, newFrontEnd, signInAll, type FrontEnd, type Sessions, type SupabaseTarget } from "./frontend";
import { BudgetExceeded, describeError, mapPool, SsrfError, type Http, type HttpResponse } from "./http";
import { scanSecrets } from "./jwt";
import { describeLogins, type ParsedLogins } from "./logins";
import { appAuthHeaders, inList, refused, type Session } from "./supabase";

/**
 * Deployed-URL checks U1–U8 (docs/07, docs/16). Admin-triggered, server-side, every request
 * through the SSRF guard and inside one time budget.
 *
 * These checks mostly read. A few write small, labelled probe rows to the candidate's database
 * (notes start with PROBE_NOTE): an interaction for agent B if B has none (U4), a valid
 * call_back control outcome (U6), and whatever a broken app lets through (U3/U6/U7), which is
 * itself the evidence. The month-2 import checks are the destructive ones and have their own
 * button.
 */

export const PROBE_NOTE = "Verification harness probe";
export const OBSERVATORY_URL = "https://observatory-api.mdn.mozilla.net";
const CONTRACT_TABLES = ["customers", "lines", "interactions"] as const;

export interface UrlCheckInput {
  http: Http;
  deployedUrl: string;
  logins: ParsedLogins;
  optouts: OptoutEntry[];
  overrides?: { supabaseUrl?: string | null; anonKey?: string | null };
  observatoryUrl?: string;
  burstSize?: number;
  /** Requests in flight during a burst. */
  burstConcurrency?: number;
  now?: Date;
}

interface Ctx {
  input: UrlCheckInput;
  http: Http;
  base: URL;
  fe: FrontEnd;
  sb: SupabaseTarget | null;
  sbProblem: string | null;
  sbCandidates: string[];
  sessions: Sessions;
  /** Customers allocated to (visible to) each agent. */
  allocated: { a: string[]; b: string[] };
}

/** Runs a check, turning time-outs and unexpected errors into "inconclusive". */
async function guard(key: CheckKey, fn: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BudgetExceeded) return inconclusive(key, "the run's time budget ran out before this check finished: run the URL checks again");
    if (err instanceof SsrfError) return inconclusive(key, `a request was blocked by the SSRF guard (${err.message})`);
    return inconclusive(key, `the check failed unexpectedly: ${describeError(err)}`);
  }
}

const json = (body: unknown) => ({ body: JSON.stringify(body), headers: { "content-type": "application/json", accept: "application/json" } });

async function appPost(ctx: Ctx, path: string, body: unknown, session: Session | null, timeoutMs = 20_000): Promise<HttpResponse> {
  const j = json(body);
  const auth = session && ctx.sb ? appAuthHeaders(ctx.sb.url, session) : {};
  return ctx.http.request(new URL(path, ctx.base), { method: "POST", body: j.body, headers: { ...j.headers, ...auth }, timeoutMs, maxBytes: 256_000 });
}

const is2xx = (s: number) => s >= 200 && s < 300;
const is4xx = (s: number) => s >= 400 && s < 500;
const looksHtml = (r: HttpResponse) => /text\/html/i.test(r.headers["content-type"] ?? "");

// ───────────────────────── U1 ─────────────────────────

/** Does a health payload report the database (db: ok / database: "up" / checks.db …)? */
export function healthReportsDb(body: unknown): { reports: boolean; value: string | null } {
  if (!body || typeof body !== "object") return { reports: false, value: null };
  const stack: [Record<string, unknown>, number][] = [[body as Record<string, unknown>, 0]];
  while (stack.length) {
    const [o, depth] = stack.pop()!;
    for (const [k, v] of Object.entries(o)) {
      if (/^(db|database|supabase|postgres(ql)?|pg|data_?base_?status|db_?status)$/i.test(k)) {
        const s = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
        const ok = v === true || (typeof v === "string" && /^(ok|up|healthy|connected|pass(ed)?|true|ready|reachable)$/i.test(v.trim())) || (typeof v === "object" && v !== null && /"(?:status|ok|state)"\s*:\s*(?:true|"(?:ok|up|healthy|connected|pass)")/i.test(s));
        return { reports: ok, value: s.slice(0, 120) };
      }
      if (v && typeof v === "object" && !Array.isArray(v) && depth < 3) stack.push([v as Record<string, unknown>, depth + 1]);
    }
  }
  return { reports: false, value: null };
}

async function u1(ctx: Ctx): Promise<CheckResult> {
  const url = new URL("/api/health", ctx.base).toString();
  let res: HttpResponse | null = null;
  let error: string | null = null;
  for (let attempt = 0; attempt < 2 && !res; attempt++) {
    try {
      res = await ctx.http.request(url, { headers: { accept: "application/json" }, timeoutMs: 10_000, maxBytes: 64_000 });
    } catch (err) {
      if (err instanceof BudgetExceeded || err instanceof SsrfError) throw err;
      error = describeError(err);
    }
  }
  if (!res) return fail("U1", `GET /api/health did not answer (${error})`, { url, error });
  const body = res.json();
  const db = healthReportsDb(body);
  const evidence: Evidence = { url, status: res.status, ms: res.ms, body: snippet(res.text(), 300), db_value: db.value };
  if (res.status !== 200) return fail("U1", `GET /api/health returned HTTP ${res.status}`, evidence);
  if (!db.reports) return fail("U1", db.value ? `GET /api/health is 200 but reports the DB as ${db.value}` : "GET /api/health is 200 but does not report the database", evidence);
  return pass("U1", `GET /api/health is 200 and reports the DB (${db.value})`, evidence);
}

// ───────────────────────── U2 ─────────────────────────

function u2(ctx: Ctx): CheckResult {
  const fe = ctx.fe;
  const hits: { where: string; kind: string; preview: string }[] = [];
  const otherRoles = new Set<string>();
  for (const [where, text] of fe.texts) {
    const s = scanSecrets(text);
    for (const j of s.serviceRoleJwts) hits.push({ where: where.replace(/#.*$/, ""), kind: `JWT with role ${j.role}`, preview: j.preview });
    for (const k of s.secretKeys) hits.push({ where: where.replace(/#.*$/, ""), kind: "sb_secret_ key", preview: k });
    s.otherJwtRoles.forEach((r) => otherRoles.add(r));
  }
  const scripts = fe.scripts.filter((s) => s.status !== null && s.status >= 200 && s.status < 300);
  const evidence: Evidence = {
    pages_scanned: fe.pages.filter((p) => p.status && p.status < 300).length,
    pages: fe.pages.slice(0, 20).map((p) => `${p.as} ${p.status ?? p.error} ${p.url}`),
    scripts_scanned: scripts.length,
    script_bytes: scripts.reduce((n, s) => n + s.bytes, 0),
    scripts_failed: fe.scripts.filter((s) => s.error).map((s) => `${s.url}: ${s.error}`).slice(0, 10),
    truncated: fe.scripts.filter((s) => s.truncated).map((s) => s.url).slice(0, 10),
    other_jwt_roles: [...otherRoles],
    limits: fe.limitsHit,
    hits: hits.slice(0, 20),
  };
  const unique = [...new Set(hits.map((h) => h.kind))];
  if (hits.length) return fail("U2", `Secret material in the shipped front end: ${unique.join(", ")} (${hits.length} occurrence${hits.length === 1 ? "" : "s"})`, evidence);
  if (!fe.pages.some((p) => p.status && p.status < 300)) return inconclusive("U2", "no page of the deployment could be fetched", evidence);
  if (!scripts.length) return inconclusive("U2", "no same-origin JS chunks were found to scan", evidence);
  return pass("U2", `No service-role JWT or sb_secret_ key in ${scripts.length} JS chunks and ${evidence.pages_scanned} pages`, evidence, fe.limitsHit.length ? `crawl limits hit (${fe.limitsHit.join("; ")}): chunks beyond them were not scanned` : undefined);
}

// ───────────────────────── U3 ─────────────────────────

async function u3(ctx: Ctx): Promise<CheckResult> {
  const sb = ctx.sb;
  if (!sb) return inconclusive("U3", ctx.sbProblem ?? "the Supabase project could not be identified", { candidates: ctx.sbCandidates });
  const rows: Evidence[] = [];
  const exposed: string[] = [];
  const unclear: string[] = [];
  let missing = 0;
  for (const t of CONTRACT_TABLES) {
    const get = await sb.probe.select(t, { select: "*", limit: "1" });
    const getOk = (is2xx(get.status) && Array.isArray(get.rows) && get.rows.length === 0) || refused(get.status);
    if (get.status === 404) missing++;
    if (is2xx(get.status) && get.rows && get.rows.length > 0) exposed.push(`anonymous read of ${t} returned rows`);
    else if (!getOk) unclear.push(`GET ${t}: HTTP ${get.status}`);

    const post = await sb.probe.insert(t, {});
    // RLS is checked before NOT NULL/CHECK constraints, so a constraint error means RLS let the row through.
    const constraint = post.code !== null && /^(23|22)/.test(post.code);
    const postRefused = refused(post.status) || post.code === "42501";
    if (is2xx(post.status)) exposed.push(`anonymous insert into ${t} succeeded`);
    else if (constraint) exposed.push(`anonymous insert into ${t} was stopped only by a constraint (${post.code}), not by RLS or grants`);
    else if (!postRefused) unclear.push(`POST ${t}: HTTP ${post.status}${post.code ? ` ${post.code}` : ""}`);
    rows.push({ table: t, get_status: get.status, get_rows: get.rows?.length ?? null, get_code: get.code, post_status: post.status, post_code: post.code, post_message: post.message });
  }
  const evidence: Evidence = { supabase_url: sb.url, via: sb.via, key_kind: sb.keyKind, verified: sb.verified, probes: rows };
  if (exposed.length) return fail("U3", `Anonymous access not refused: ${exposed.join("; ")}`, evidence);
  if (missing === CONTRACT_TABLES.length) return inconclusive("U3", "none of customers, lines, interactions exist under those names (renamed?): judge by hand", evidence);
  if (unclear.length) return inconclusive("U3", `unexpected responses: ${unclear.join("; ")}`, evidence);
  return pass("U3", "Anonymous reads of customers, lines and interactions return nothing or are refused, and anonymous inserts are refused", evidence);
}

// ───────────────────────── U4 ─────────────────────────

type Row = Record<string, unknown>;
const ids = (rows: Row[] | null, col = "id") => (rows ?? []).map((r) => String(r[col])).filter((x) => x && x !== "undefined" && x !== "null");

async function loadAllocations(ctx: Ctx): Promise<void> {
  const sb = ctx.sb!;
  for (const who of ["a", "b"] as const) {
    const s = ctx.sessions[who];
    if (!s) continue;
    const r = await sb.probe.select("allocations", { select: "customer_id,agent_id", agent_id: `eq.${s.userId}`, limit: "1000" }, s);
    let list = is2xx(r.status) ? ids(r.rows, "customer_id") : [];
    if (!list.length) {
      // No allocations table (or none for this agent): fall back to the customers this agent can see.
      const c = await sb.probe.select("customers", { select: "id", limit: "200" }, s);
      list = is2xx(c.status) ? ids(c.rows) : [];
    }
    ctx.allocated[who] = [...new Set(list)];
  }
}

async function u4(ctx: Ctx): Promise<CheckResult> {
  const { a, b } = ctx.sessions;
  const sb = ctx.sb;
  if (!sb) return inconclusive("U4", ctx.sbProblem ?? "the Supabase project could not be identified");
  if (!a || !b) return inconclusive("U4", `two agent sign-ins are needed (${ctx.sessions.errors.join("; ") || "missing logins"})`, { logins: describeLogins(ctx.sessions.logins) });
  const leaks: string[] = [];
  const evidence: Evidence = { agent_a: a.email, agent_b: b.email };
  const bOnly = ctx.allocated.b.filter((c) => !ctx.allocated.a.includes(c));
  evidence.b_only_customers = bOnly.length;

  // B's own rows (as B).
  const bAlloc = await sb.probe.select("allocations", { select: "id,customer_id,agent_id", agent_id: `eq.${b.userId}`, limit: "200" }, b);
  let bInter = await sb.probe.select("interactions", { select: "id,customer_id,agent_id", agent_id: `eq.${b.userId}`, limit: "200" }, b);
  let probeCreated: string | null = null;
  if (is2xx(bInter.status) && !(bInter.rows ?? []).length && (bOnly[0] ?? ctx.allocated.b[0])) {
    // B has no interactions: log one as B so there is something of B's to look for.
    const customer = bOnly[0] ?? ctx.allocated.b[0];
    const ins = await sb.probe.insert("interactions", { customer_id: customer, agent_id: b.userId, outcome: "no_answer", notes: `${PROBE_NOTE} (U4): interaction owned by agent B` }, b, "return=representation");
    if (is2xx(ins.status)) probeCreated = "rest";
    else {
      const api = await appPost(ctx, "/api/outcomes", { customerId: customer, outcome: "no_answer", notes: `${PROBE_NOTE} (U4): interaction owned by agent B` }, b).catch(() => null);
      if (api && is2xx(api.status)) probeCreated = "api";
    }
    if (probeCreated) bInter = await sb.probe.select("interactions", { select: "id,customer_id,agent_id", agent_id: `eq.${b.userId}`, limit: "200" }, b);
  }
  const bInterIds = ids(bInter.rows);
  const bAllocIds = ids(bAlloc.rows);
  evidence.b_rows = { allocations: bAlloc.status === 200 ? bAllocIds.length : `HTTP ${bAlloc.status}`, interactions: bInter.status === 200 ? bInterIds.length : `HTTP ${bInter.status}`, probe_interaction: probeCreated ?? "none" };

  // As A: anything of B's?
  const probes: Evidence[] = [];
  const aInterByAgent = await sb.probe.select("interactions", { select: "id,agent_id", agent_id: `eq.${b.userId}`, limit: "50" }, a);
  probes.push({ probe: "REST interactions where agent_id = B", status: aInterByAgent.status, rows: aInterByAgent.rows?.length ?? null });
  if ((aInterByAgent.rows ?? []).length) leaks.push(`agent A reads ${aInterByAgent.rows!.length} of agent B's interactions via REST`);
  if (bInterIds.length) {
    const aInterById = await sb.probe.select("interactions", { select: "id", id: inList(bInterIds.slice(0, 50)) }, a);
    probes.push({ probe: "REST interactions by B's ids", status: aInterById.status, rows: aInterById.rows?.length ?? null });
    if ((aInterById.rows ?? []).length && !(aInterByAgent.rows ?? []).length) leaks.push(`agent A reads ${aInterById.rows!.length} of agent B's interactions by id`);
  }
  const aAlloc = await sb.probe.select("allocations", { select: "id,agent_id", agent_id: `eq.${b.userId}`, limit: "50" }, a);
  probes.push({ probe: "REST allocations where agent_id = B", status: aAlloc.status, rows: aAlloc.rows?.length ?? null });
  if ((aAlloc.rows ?? []).length) leaks.push(`agent A reads ${aAlloc.rows!.length} of agent B's allocations via REST`);
  if (bOnly.length) {
    const aCust = await sb.probe.select("customers", { select: "id", id: inList(bOnly.slice(0, 50)) }, a);
    probes.push({ probe: "REST customers allocated only to B", status: aCust.status, rows: aCust.rows?.length ?? null });
    if ((aCust.rows ?? []).length) leaks.push(`agent A reads ${aCust.rows!.length} customers allocated only to agent B`);

    // App routes: the AI summary and the customer page for B's customer.
    const target = bOnly[0];
    const sum = await appPost(ctx, "/api/summary", { customerId: target }, a, 25_000).catch((e) => e as Error);
    if (!(sum instanceof Error)) {
      probes.push({ probe: "POST /api/summary for B's customer as A", status: sum.status, body: snippet(sum.text(), 160) });
      if (is2xx(sum.status)) leaks.push(`POST /api/summary as agent A returned ${sum.status} for a customer allocated only to agent B`);
    } else probes.push({ probe: "POST /api/summary for B's customer as A", error: describeError(sum) });

    const name = await sb.probe.select("customers", { select: "legal_name", id: `eq.${target}` }, b);
    const legal = String(name.rows?.[0]?.legal_name ?? "").trim();
    if (legal.length >= 4) {
      for (const path of [`/customers/${target}`, `/customer/${target}`]) {
        const url = new URL(path, ctx.base).toString();
        const asB = await ctx.http.request(url, { headers: appAuthHeaders(sb.url, b), timeoutMs: 12_000, maxBytes: 1_000_000 }).catch(() => null);
        if (!asB || asB.status !== 200 || !asB.text().toLowerCase().includes(legal.toLowerCase())) continue;
        const asA = await ctx.http.request(url, { headers: appAuthHeaders(sb.url, a), timeoutMs: 12_000, maxBytes: 1_000_000 }).catch(() => null);
        const shown = !!asA && asA.status === 200 && asA.text().toLowerCase().includes(legal.toLowerCase());
        probes.push({ probe: `GET ${path} as A (B sees the customer there)`, status: asA?.status ?? null, shows_customer: shown });
        if (shown) leaks.push(`agent A can open ${path} (a customer allocated only to agent B)`);
        break;
      }
    }
  }
  evidence.probes = probes;
  if (leaks.length) return fail("U4", `Cross-tenant leak: ${leaks.join("; ")}`, evidence);
  const restRan = [aInterByAgent.status, aAlloc.status].some((s) => is2xx(s) || refused(s));
  if (!restRan) return inconclusive("U4", "agent A's REST probes returned neither data nor a refusal", evidence);
  if (!bInterIds.length && !bAllocIds.length) return inconclusive("U4", "agent B has no interactions or allocations to look for (and a probe interaction could not be created)", evidence);
  return pass("U4", `Agent A sees none of agent B's ${bInterIds.length} interactions or ${bAllocIds.length} allocations (REST and app routes)`, evidence);
}

// ───────────────────────── U5 ─────────────────────────

async function burst(ctx: Ctx, session: Session | null, customerId: string, opts: { size: number; stop: (counts: Map<string, number>, status: number | null) => boolean }) {
  const counts = new Map<string, number>();
  let sent = 0;
  let first429: number | null = null;
  let stopped = false;
  const statuses: (number | string)[] = [];
  const indices = Array.from({ length: opts.size }, (_, i) => i);
  await mapPool(indices, ctx.input.burstConcurrency ?? 10, async (i) => {
    if (stopped) return;
    if (ctx.http.budget.remaining() < 8_000) {
      stopped = true;
      return;
    }
    sent++;
    let status: number | null = null;
    try {
      const r = await appPost(ctx, "/api/summary", { customerId }, session, 20_000);
      status = r.status;
    } catch (err) {
      if (err instanceof SsrfError) throw err;
    }
    const key = status === null ? "error" : String(status);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (statuses.length < 120) statuses.push(status ?? "err");
    if (status === 429 && first429 === null) first429 = i + 1;
    if (opts.stop(counts, status)) stopped = true;
  });
  return { counts: Object.fromEntries(counts), sent, first429, budgetStopped: sent < opts.size && ctx.http.budget.remaining() < 8_000 };
}

async function u5(ctx: Ctx): Promise<CheckResult> {
  const size = ctx.input.burstSize ?? 100;
  const customer = ctx.allocated.a[0] ?? ctx.allocated.b[0] ?? "00000000-0000-0000-0000-000000000000";
  const okUnauth = (s: string) => ["401", "403", "429"].includes(s) || /^3\d\d$/.test(s);
  // Stop early on the third anonymous success: the fault is proven and each success costs an LLM call.
  const anon = await burst(ctx, null, customer, { size, stop: (c) => [...c.entries()].filter(([k]) => /^2/.test(k)).reduce((n, [, v]) => n + v, 0) >= 3 });
  const anonEntries = Object.entries(anon.counts);
  const evidence: Evidence = { requests: size, customer_id: customer, unauthenticated: anon.counts, unauthenticated_sent: anon.sent };
  const anonOk = anonEntries.filter(([k]) => /^2/.test(k)).reduce((n, [, v]) => n + v, 0);
  if (anonOk > 0) return fail("U5", `/api/summary answered ${anonOk} unauthenticated request${anonOk === 1 ? "" : "s"} with 2xx (no auth on the AI route)`, evidence);
  if ((anon.counts["404"] ?? 0) === anon.sent && anon.sent > 0) return inconclusive("U5", "/api/summary returns 404 (route renamed?)", evidence);
  const anonBad = anonEntries.filter(([k]) => !okUnauth(k));
  if (anonBad.length) evidence.unauthenticated_unexpected = anonBad.map(([k, v]) => `${k} x${v}`);

  const a = ctx.sessions.a;
  if (!a) return inconclusive("U5", `unauthenticated requests are refused, but no agent could sign in to test the per-user limit (${ctx.sessions.errors.join("; ")})`, evidence);
  const authed = await burst(ctx, a, customer, { size, stop: (_c, s) => s === 429 });
  evidence.authenticated = authed.counts;
  evidence.authenticated_sent = authed.sent;
  evidence.first_429_at = authed.first429;
  if (authed.first429 !== null) {
    if (anonBad.length) return inconclusive("U5", `the per-user limit works (429 at request ${authed.first429}), but some unauthenticated requests got unexpected statuses (${anonBad.map(([k]) => k).join(", ")})`, evidence);
    return pass("U5", `Unauthenticated requests refused; authenticated burst hit 429 at request ${authed.first429}`, evidence);
  }
  if ((authed.counts["401"] ?? 0) + (authed.counts["403"] ?? 0) === authed.sent && authed.sent > 0) return inconclusive("U5", "the app refused the signed-in agent too (session not accepted?): test the limit by hand", evidence);
  if (authed.budgetStopped) return inconclusive("U5", `the time budget ran out after ${authed.sent} authenticated requests without a 429`, evidence);
  return inconclusive("U5", `no 429 within ${authed.sent} authenticated requests: check the README for a documented per-user cap and record the result by hand`, evidence);
}

// ───────────────────────── U6 ─────────────────────────

async function u6(ctx: Ctx): Promise<CheckResult> {
  const sb = ctx.sb;
  const a = ctx.sessions.a;
  if (!sb) return inconclusive("U6", ctx.sbProblem ?? "the Supabase project could not be identified");
  if (!a) return inconclusive("U6", `no agent could sign in (${ctx.sessions.errors.join("; ")})`);
  const customer = ctx.allocated.a[0];
  if (!customer) return inconclusive("U6", "agent A has no allocated customer to log an outcome for");
  const evidence: Evidence = { agent: a.email, customer_id: customer };

  // 1. The DB path, bypassing the app: an insert without next_action_at must fail.
  let rest = await sb.probe.insert("interactions", { customer_id: customer, agent_id: a.userId, outcome: "call_back", notes: `${PROBE_NOTE} (U6): call_back without a date` }, a, "return=representation");
  if (rest.code === "PGRST204") rest = await sb.probe.insert("interactions", { customer_id: customer, outcome: "call_back", notes: `${PROBE_NOTE} (U6): call_back without a date` }, a, "return=representation");
  evidence.rest = { status: rest.status, code: rest.code, message: rest.message };
  const restCreated = is2xx(rest.status);
  // Refused by RLS/grants (the DB path is closed) or by a constraint/trigger (23xxx, P0xxx).
  const restHeld = !restCreated && (rest.status === 401 || rest.status === 403 || rest.code === "42501" || (rest.code !== null && /^(23|P0)/.test(rest.code)));

  // 2. The app route, bypassing the UI.
  const api = await appPost(ctx, "/api/outcomes", { customerId: customer, outcome: "call_back", notes: `${PROBE_NOTE} (U6): call_back without a date` }, a);
  evidence.api = { status: api.status, body: snippet(api.text(), 200) };
  if (restCreated || is2xx(api.status)) {
    const where = [restCreated ? "the database accepted a REST insert" : null, is2xx(api.status) ? `POST /api/outcomes returned ${api.status}` : null].filter(Boolean).join(" and ");
    return fail("U6", `A call_back without a callback date was saved: ${where}`, evidence);
  }
  if (api.status === 404 && looksHtml(api)) return inconclusive("U6", "POST /api/outcomes is not found (route renamed?)", evidence);
  if (api.status === 401) return inconclusive("U6", "POST /api/outcomes refused the signed-in agent (401): session not accepted, test by hand", evidence);

  // 3. Control: the same call with a date must be accepted, or the refusal proves nothing.
  const tomorrow = new Date((ctx.input.now ?? new Date()).getTime() + 86_400_000);
  tomorrow.setUTCHours(7, 0, 0, 0);
  const control = await appPost(ctx, "/api/outcomes", { customerId: customer, outcome: "call_back", nextActionAt: tomorrow.toISOString(), notes: `${PROBE_NOTE} (U6 control): valid call_back` }, a);
  evidence.control = { status: control.status, body: snippet(control.text(), 160) };
  if (!is2xx(control.status)) return inconclusive("U6", `the app also refused a valid call_back with a date (HTTP ${control.status}), so the refusal proves nothing`, evidence);
  if (!is4xx(api.status)) return inconclusive("U6", `POST /api/outcomes without a date returned HTTP ${api.status} (expected 4xx)`, evidence);
  if (!restHeld) return inconclusive("U6", `the REST insert returned HTTP ${rest.status}${rest.code ? ` (${rest.code})` : ""}: unclear whether the DB rule holds`, evidence);
  return pass("U6", `call_back without a date refused by the API (${api.status}) and the database (${rest.code ?? rest.status}); a dated call_back is accepted`, evidence);
}

// ───────────────────────── U7 ─────────────────────────

async function u7(ctx: Ctx): Promise<CheckResult> {
  const sb = ctx.sb;
  if (!sb) return inconclusive("U7", ctx.sbProblem ?? "the Supabase project could not be identified");
  const sessions = [
    ["agent A", ctx.sessions.a],
    ["agent B", ctx.sessions.b],
    ["manager", ctx.sessions.manager],
  ].filter((x): x is [string, Session] => !!x[1]);
  if (!sessions.length) return inconclusive("U7", `nobody could sign in (${ctx.sessions.errors.join("; ")})`);

  let entries = ctx.input.optouts;
  const evidence: Evidence = {};
  if (!entries.length && ctx.sessions.manager) {
    // No bundle list: use the app's own opt-out table.
    const o = await sb.probe.select("optouts", { select: "company_name,normalised_name,customer_id", limit: "200" }, ctx.sessions.manager);
    entries = (o.rows ?? []).map((r) => ({ listedName: String(r.company_name ?? ""), normalised: String(r.normalised_name ?? ""), status: "Opted out", regNo: null, accountNos: [] }));
    evidence.list_source = `app optouts table (${entries.length})`;
  } else evidence.list_source = `bundle opt-out list (${entries.length} names)`;
  if (!entries.length) return inconclusive("U7", "no opt-out list available (bundle missing and the app's optouts table is empty or unreadable)", evidence);

  let pick: { who: string; session: Session; customer: CustomerLite; via: string; listed: string } | null = null;
  for (const [who, s] of sessions) {
    const c = await sb.probe.selectAll<CustomerLite>("customers", { select: "id,reg_no,legal_name,normalised_name" }, s, 5000);
    const rows = c.rows ?? (await sb.probe.selectAll<CustomerLite>("customers", { select: "*" }, s, 5000)).rows ?? [];
    const matches = matchOptouts(rows, entries);
    evidence[`matches_${who.replace(/\s+/g, "_").toLowerCase()}`] = matches.length;
    if (matches.length) {
      const m = matches[0];
      pick = { who, session: s, customer: m.customer, via: m.via, listed: m.entry.listedName };
      break;
    }
  }
  if (!pick) return inconclusive("U7", "none of the customers the test users can see is on the opt-out list (by reg no or normalised name)", evidence);
  evidence.customer = { id: pick.customer.id, legal_name: pick.customer.legal_name ?? null, listed_as: pick.listed, matched_by: pick.via, as: pick.who };

  const t = await sb.probe.select<Row>("templates", { select: "id,name,category,approved", limit: "50" }, pick.session);
  const templates = t.rows ?? [];
  const template =
    templates.find((x) => x.approved === true && /utility/i.test(String(x.category ?? ""))) ?? templates.find((x) => x.approved === true) ?? templates[0];
  if (!template) return inconclusive("U7", `no message template is visible to the ${pick.who} (HTTP ${t.status})`, evidence);
  evidence.template = { id: String(template.id), name: String(template.name ?? ""), approved: Boolean(template.approved) };

  const api = await appPost(ctx, "/api/messages", { customerId: pick.customer.id, templateId: template.id }, pick.session);
  const body = api.text();
  evidence.api = { status: api.status, body: snippet(body, 200) };
  const rest = await sb.probe.insert("message_queue", { customer_id: pick.customer.id, template_id: template.id, status: "queued", created_by: pick.session.userId }, pick.session, "return=representation");
  evidence.rest = { status: rest.status, code: rest.code, message: rest.message };

  const queued = [is2xx(api.status) ? `POST /api/messages returned ${api.status}` : null, is2xx(rest.status) ? "a REST insert into message_queue succeeded" : null].filter(Boolean);
  if (queued.length) return fail("U7", `A message was queued to an opted-out customer (${pick.listed}): ${queued.join("; ")}`, evidence);
  if (api.status === 401) return inconclusive("U7", "POST /api/messages refused the signed-in user (401): session not accepted, test by hand", evidence);
  if (api.status === 404 && (looksHtml(api) || !/opt|consent|block/i.test(body))) return inconclusive("U7", "POST /api/messages returned 404 (route renamed?)", evidence);
  if (!is4xx(api.status)) return inconclusive("U7", `POST /api/messages returned HTTP ${api.status} (expected 4xx)`, evidence);
  const saysOptOut = /opt[\s_-]?(?:ed[\s_-]?)?out|do[\s_-]?not[\s_-]?contact|legal|unsubscrib|suppress/i.test(body);
  return pass(
    "U7",
    `Message to opted-out customer "${pick.listed}" refused by the API (${api.status}) and the database (${rest.code ?? rest.status})`,
    evidence,
    saysOptOut ? undefined : "the refusal does not mention the opt-out: confirm it was refused for that reason (not, say, a missing consented contact)",
  );
}

// ───────────────────────── U8 ─────────────────────────

async function u8(ctx: Ctx): Promise<CheckResult> {
  const host = ctx.base.hostname;
  const observatory = (ctx.input.observatoryUrl ?? OBSERVATORY_URL).replace(/\/+$/, "");
  if ((/^[\d.]+$/.test(host) || host.includes(":") || host === "localhost") && observatory === OBSERVATORY_URL) {
    return { key: "U8", passed: null, detail: { summary: "Not scanned: the deployment is not on a public host name", inconclusive: true, reason: "not a public host name", evidence: { host } } };
  }
  const res = await ctx.http.request(`${observatory}/api/v2/scan?host=${encodeURIComponent(host)}`, { method: "POST", headers: { accept: "application/json" }, timeoutMs: 45_000, maxBytes: 256_000 });
  const j = res.json<Record<string, unknown>>();
  if (res.status !== 200 || !j || typeof j.grade !== "string") {
    const err = typeof j?.error === "string" ? j.error : typeof j?.message === "string" ? j.message : `HTTP ${res.status}`;
    return { key: "U8", passed: null, detail: { summary: `Observatory scan failed: ${String(err).slice(0, 200)}`, inconclusive: true, reason: String(err).slice(0, 200), evidence: { host, status: res.status } } };
  }
  return informational("U8", `MDN Observatory grade ${j.grade} (score ${j.score ?? "?"}; ${j.tests_passed ?? "?"}/${j.tests_quantity ?? "?"} tests passed)`, {
    host,
    grade: j.grade,
    score: (j.score as number | undefined) ?? null,
    tests_passed: (j.tests_passed as number | undefined) ?? null,
    tests_failed: (j.tests_failed as number | undefined) ?? null,
    tests_quantity: (j.tests_quantity as number | undefined) ?? null,
    details_url: typeof j.details_url === "string" ? j.details_url : null,
    scanned_at: typeof j.scanned_at === "string" ? j.scanned_at : null,
  });
}

// ───────────────────────── Orchestration ─────────────────────────

/** Runs U1–U8 and returns one result per key (always all eight). */
export async function runUrlChecks(input: UrlCheckInput): Promise<{ results: CheckResult[]; context: Evidence }> {
  let base: URL;
  try {
    base = new URL(input.deployedUrl);
  } catch {
    const results = (["U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8"] as const).map((k) => inconclusive(k, "the submitted deployed URL is not a valid URL"));
    return { results, context: {} };
  }
  base = new URL(base.origin + "/");
  const ctx: Ctx = {
    input,
    http: input.http,
    base,
    fe: newFrontEnd(base),
    sb: null,
    sbProblem: null,
    sbCandidates: [],
    sessions: { a: null, b: null, manager: null, errors: [], logins: input.logins },
    allocated: { a: [], b: [] },
  };
  const u1p = guard("U1", () => u1(ctx));
  const u8p = guard("U8", () => u8(ctx));

  // Public crawl → Supabase target → sign-ins → authenticated crawl.
  const setup: string[] = [];
  try {
    await crawlPublic(ctx.http, ctx.fe);
    const found = await findSupabase(ctx.http, ctx.fe, input.overrides);
    ctx.sb = found.target;
    ctx.sbProblem = found.problem;
    ctx.sbCandidates = found.candidates;
    ctx.sessions = await signInAll(ctx.sb, input.logins);
    if (ctx.sb && (ctx.sessions.a || ctx.sessions.manager)) await crawlAuthenticated(ctx.http, ctx.fe, ctx.sb, ctx.sessions);
    if (ctx.sb) await loadAllocations(ctx);
  } catch (err) {
    setup.push(describeError(err));
  }

  const results: CheckResult[] = [];
  results.push(await guard("U2", async () => u2(ctx)));
  results.push(await guard("U3", () => u3(ctx)));
  results.push(await guard("U4", () => u4(ctx)));
  results.push(await guard("U6", () => u6(ctx)));
  results.push(await guard("U7", () => u7(ctx)));
  results.push(await guard("U5", () => u5(ctx)));
  results.push(await u1p, await u8p);

  const context: Evidence = {
    deployed_url: base.toString(),
    supabase_url: ctx.sb?.url ?? null,
    supabase_via: ctx.sb ? `${ctx.sb.via}${ctx.sb.verified ? "" : " (unverified)"}` : null,
    supabase_problem: ctx.sbProblem,
    logins: describeLogins(input.logins),
    signed_in: { agent_a: !!ctx.sessions.a, agent_b: !!ctx.sessions.b, manager: !!ctx.sessions.manager },
    sign_in_errors: ctx.sessions.errors,
    setup_errors: setup,
  };
  // Every check carries the shared context so a reviewer sees why something was inconclusive.
  for (const r of results) r.detail.evidence = { ...(r.detail.evidence ?? {}), run: { supabase_url: context.supabase_url, signed_in: context.signed_in, sign_in_errors: context.sign_in_errors } };
  const order = ["U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8"];
  results.sort((x, y) => order.indexOf(x.key) - order.indexOf(y.key));
  return { results, context };
}
