import "server-only";
import { applySetCookies, cookieHeaderOf, looksLikeLoginPage, parseLoginForms, sessionFromCookies } from "./app-login";
import { extractCustomerLinks, extractPageLinks, extractScriptUrls, extractSupabaseConfig, routeShape, type EntityLink, type SupabaseCandidate } from "./bundle";
import { BudgetExceeded, describeError, mapPool, multipartFields, SsrfError, type Http, type HttpResponse } from "./http";
import { isPrivilegedKey } from "./jwt";
import { appAuthHeaders, ProbeError, SupabaseProbe, type Session } from "./supabase";
import type { Login, ParsedLogins } from "./logins";

/**
 * Crawls the candidate's deployed front end (public pages first, then as the test users) and
 * collects every same-origin JS chunk, so U2 can scan them and U3/U4/import checks can find the
 * Supabase URL and publishable key the browser uses.
 *
 * Signing in: with a publishable key (from the bundle, the test logins or the admin's form) the
 * harness uses Supabase Auth directly. Apps that keep Supabase server-side ship no key, so the
 * harness then signs in through the app's own login form like a browser without JavaScript,
 * and uses the cookies the app sets. Signed-in pages often ship the chunks a public crawl never
 * sees (F04's service key sits in a signed-in client component), and sometimes the key itself.
 */

export const CRAWL_LIMITS = { pages: 14, scripts: 70, scriptBytes: 2 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 } as const;
const GUESSED_PATHS = ["/", "/login", "/queue", "/renewals", "/customers", "/dashboard", "/manager", "/import", "/imports", "/messages", "/admin"];
const LOGIN_PATHS = ["/login", "/sign-in", "/signin", "/auth/login", "/auth/sign-in", "/"];

export interface FetchedText {
  url: string;
  status: number | null;
  bytes: number;
  truncated: boolean;
  error: string | null;
  /** Which session fetched it (for pages). */
  as: string;
  /** Where redirects ended (pages): a signed-in fetch that lands on the login page was not signed in. */
  finalUrl?: string;
}

export interface FrontEnd {
  base: URL;
  pages: FetchedText[];
  scripts: FetchedText[];
  /** url → text, for scanning (not stored). */
  texts: Map<string, string>;
  totalBytes: number;
  limitsHit: string[];
  /** Content-Security-Policy headers seen on pages (connect-src names the Supabase URL). */
  csp: string[];
  /** Customer-page links seen by each session (anon, agent_a, agent_b, manager). */
  customerLinks: Record<string, EntityLink[]>;
}

export interface SupabaseTarget {
  probe: SupabaseProbe;
  url: string;
  via: string;
  keyKind: string;
  verified: boolean;
}

export interface Sessions {
  a: Session | null;
  b: Session | null;
  manager: Session | null;
  errors: string[];
  logins: ParsedLogins;
}

export function newFrontEnd(base: URL): FrontEnd {
  return { base, pages: [], scripts: [], texts: new Map(), totalBytes: 0, limitsHit: [], csp: [], customerLinks: {} };
}

async function fetchText(http: Http, fe: FrontEnd, url: string, headers: Record<string, string>, maxBytes: number, as: string, follow: number): Promise<FetchedText & { text: string | null; finalUrl: string }> {
  try {
    const res = await http.request(url, { headers: { accept: "text/html,application/javascript,*/*;q=0.5", ...headers }, maxBytes, timeoutMs: 12_000, followRedirects: follow });
    const text = res.status >= 200 && res.status < 300 ? res.text() : null;
    if (text) fe.totalBytes += res.body.length;
    const csp = res.headers["content-security-policy"];
    if (csp && !fe.csp.includes(csp) && fe.csp.length < 10) fe.csp.push(csp.slice(0, 4000));
    return { url, status: res.status, bytes: res.body.length, truncated: res.truncated, error: null, as, text, finalUrl: res.url };
  } catch (err) {
    if (err instanceof BudgetExceeded) throw err;
    return { url, status: null, bytes: 0, truncated: false, error: describeError(err), as, text: null, finalUrl: url };
  }
}

/**
 * Fetches pages as one session (or anonymously), at most CRAWL_LIMITS.pages per session, then
 * their not-yet-seen scripts. With discoverLinks, links found on the first round are fetched
 * in a second round (one level deep), one page per route shape (/customers/:id once, not 200
 * customer pages that load the same chunks).
 */
export async function crawl(http: Http, fe: FrontEnd, paths: string[], opts: { headers?: Record<string, string>; as: string; discoverLinks?: boolean }): Promise<void> {
  const headers = opts.headers ?? {};
  const mine = () => fe.pages.filter((p) => p.as === opts.as);
  const scripts: string[] = [];
  const shapes = new Set(mine().map((p) => routeShape(new URL(p.url))));
  let round = [...new Set(paths.map((p) => new URL(p, fe.base).toString()))];
  for (let depth = 0; depth < (opts.discoverLinks ? 2 : 1) && round.length; depth++) {
    const done = new Set(mine().map((p) => p.url));
    const todo = round.filter((u) => !done.has(u));
    const room = Math.max(0, CRAWL_LIMITS.pages - done.size);
    if (todo.length > room && !fe.limitsHit.includes(`pages capped at ${CRAWL_LIMITS.pages} (${opts.as})`)) fe.limitsHit.push(`pages capped at ${CRAWL_LIMITS.pages} (${opts.as})`);
    todo.slice(0, room).forEach((u) => shapes.add(routeShape(new URL(u))));
    const fetched = await mapPool(todo.slice(0, room), 4, (u) => fetchText(http, fe, u, headers, CRAWL_LIMITS.scriptBytes, opts.as, 3));
    const links: string[] = [];
    for (const p of fetched) {
      const { text, ...meta } = p;
      const finalUrl = p.finalUrl;
      fe.pages.push(meta);
      if (!text) continue;
      // Parsing is linear (html-scan.ts), but a slow run must still stop inside the route's maxDuration.
      http.budget.ensure(2_000);
      const at = new URL(finalUrl);
      fe.texts.set(`${finalUrl}#${opts.as}`, text);
      for (const s of extractScriptUrls(text, at)) if (!scripts.includes(s)) scripts.push(s);
      const seen = new Set((fe.customerLinks[opts.as] ??= []).map((l) => l.id));
      for (const l of extractCustomerLinks(text, at)) if (!seen.has(l.id) && fe.customerLinks[opts.as].length < 500) fe.customerLinks[opts.as].push(l);
      for (const l of extractPageLinks(text, at)) {
        const shape = routeShape(new URL(l));
        if (shapes.has(shape) || links.includes(l)) continue;
        shapes.add(shape);
        links.push(l);
      }
    }
    round = links;
  }
  await fetchScripts(http, fe, scripts.filter((s) => !fe.scripts.some((x) => x.url === s)));
}

async function fetchScripts(http: Http, fe: FrontEnd, urls: string[]): Promise<void> {
  const room = CRAWL_LIMITS.scripts - fe.scripts.length;
  if (urls.length > room) fe.limitsHit.push(`scripts capped at ${CRAWL_LIMITS.scripts}`);
  const todo = urls.slice(0, Math.max(0, room));
  // Placeholders first, so a parallel crawl does not fetch the same chunk twice.
  for (const u of todo) fe.scripts.push({ url: u, status: null, bytes: 0, truncated: false, error: "pending", as: "anon" });
  await mapPool(todo, 6, async (u) => {
    const slot = fe.scripts.find((s) => s.url === u)!;
    if (fe.totalBytes >= CRAWL_LIMITS.totalBytes) {
      slot.error = "skipped: total download cap reached";
      if (!fe.limitsHit.includes("total bytes cap")) fe.limitsHit.push("total bytes cap");
      return;
    }
    // Chunks are public static files: fetched without cookies.
    const r = await fetchText(http, fe, u, {}, CRAWL_LIMITS.scriptBytes, "anon", 2);
    Object.assign(slot, { status: r.status, bytes: r.bytes, truncated: r.truncated, error: r.error });
    if (r.text) fe.texts.set(u, r.text);
  });
}

/** The public crawl: the home page, the login page and their links. */
export async function crawlPublic(http: Http, fe: FrontEnd): Promise<void> {
  await crawl(http, fe, ["/", "/login"], { as: "anon", discoverLinks: true });
}

/**
 * Signed-in crawl: guessed app paths and their links, as agent A and the manager (and agent B,
 * guessed paths only, for the customer links U4 compares when there is no REST access).
 */
export async function crawlAuthenticated(http: Http, fe: FrontEnd, supabaseUrl: string | null, sessions: Sessions, opts: { includeB?: boolean } = {}): Promise<void> {
  const who: [string, Session | null, boolean][] = [
    ["agent_a", sessions.a, true],
    ["manager", sessions.manager, true],
    ...(opts.includeB ? ([["agent_b", sessions.b, false]] as [string, Session | null, boolean][]) : []),
  ];
  for (const [as, s, discover] of who) {
    if (!s) continue;
    await crawl(http, fe, GUESSED_PATHS, { headers: appAuthHeaders(supabaseUrl, s), as, discoverLinks: discover });
  }
}

/**
 * Picks the Supabase project: admin overrides first, then the signed-in token's issuer, then
 * bundle candidates, verified with GET /auth/v1/settings (the first that answers like Supabase
 * wins; unverified best guess otherwise). Only a publishable / anon key is ever used.
 */
export async function findSupabase(
  http: Http,
  fe: FrontEnd,
  overrides: { supabaseUrl?: string | null; anonKey?: string | null } = {},
  extra: SupabaseCandidate[] = [],
): Promise<{ target: SupabaseTarget | null; problem: string | null; candidates: string[] }> {
  const cfg = extractSupabaseConfig([...fe.texts.values()], fe.base.origin, fe.csp);
  // A secret / service-role key would bypass RLS and make every probe meaningless: never use one.
  const given = overrides.anonKey && !isPrivilegedKey(overrides.anonKey) ? overrides.anonKey : null;
  const key = given || cfg.key;
  const seen = new Set<string>();
  const candidates = [...(overrides.supabaseUrl ? [{ url: overrides.supabaseUrl.replace(/\/+$/, ""), via: "admin override" as const }] : []), ...extra, ...cfg.candidates].filter((c) => !seen.has(c.url) && !!seen.add(c.url));
  if (!key) {
    const where = candidates[0] ? ` (the Supabase URL looks like ${candidates[0].url}, from ${candidates[0].via})` : "";
    return {
      target: null,
      problem: `no publishable/anon key: the app keeps Supabase server-side${where}. Add the project's publishable key in the harness form, or ask the candidate to add "supabase: <project URL> / <publishable key>" to the test logins (it is public by design)`,
      candidates: candidates.map((c) => c.url),
    };
  }
  if (!candidates.length) return { target: null, problem: "no Supabase URL found in the bundle (enter it in the harness form)", candidates: [] };
  const keyKind = given ? "provided (harness form or test logins)" : (cfg.keyKind ?? "unknown");
  for (const c of candidates.slice(0, 4)) {
    let probe: SupabaseProbe;
    try {
      probe = new SupabaseProbe(http, c.url, key);
    } catch {
      continue;
    }
    if (await probe.looksLikeSupabase()) return { target: { probe, url: probe.url, via: c.via, keyKind, verified: true }, problem: null, candidates: candidates.map((x) => x.url) };
  }
  const best = candidates[0];
  return {
    target: { probe: new SupabaseProbe(http, best.url, key), url: best.url.replace(/\/+$/, ""), via: best.via, keyKind, verified: false },
    problem: null,
    candidates: candidates.map((x) => x.url),
  };
}

/**
 * Signs in through the app's login form like a browser without JavaScript (see app-login.ts).
 * The password goes only to the deployment's own origin.
 */
export async function signInWithForm(http: Http, base: URL, login: Login): Promise<{ session: Session | null; issuer: string | null; error: string | null }> {
  let problem = `no login form (an email and a password field) on ${LOGIN_PATHS.join(", ")}`;
  for (const p of LOGIN_PATHS) {
    const jar = new Map<string, string>();
    let page: HttpResponse;
    try {
      page = await http.request(new URL(p, base), { headers: { accept: "text/html" }, followRedirects: 3, timeoutMs: 12_000, maxBytes: 1_000_000 });
    } catch (err) {
      if (err instanceof BudgetExceeded || err instanceof SsrfError) throw err;
      continue;
    }
    if (page.status !== 200) continue;
    applySetCookies(jar, page.setCookies);
    const form = parseLoginForms(page.text(), page.url).find((f) => f.method === "POST");
    if (!form) continue;
    if (new URL(form.action).origin !== base.origin) {
      problem = `the login form on ${p} posts to another origin (${new URL(form.action).origin}): not sent`;
      continue;
    }
    const fields: [string, string][] = [...form.fields, [form.emailField, login.email], [form.passwordField, login.password]];
    const body = form.multipart ? multipartFields(fields) : { body: Buffer.from(new URLSearchParams(fields).toString()), contentType: "application/x-www-form-urlencoded" };
    let res: HttpResponse;
    try {
      res = await http.request(form.action, {
        method: "POST",
        body: body.body,
        // A browser sends Origin and Referer with a form post (Next.js checks Origin on server actions).
        headers: { "content-type": body.contentType, accept: "text/html,*/*;q=0.5", origin: base.origin, referer: page.url, ...(jar.size ? { cookie: cookieHeaderOf(jar) } : {}) },
        timeoutMs: 20_000,
        maxBytes: 1_000_000,
      });
    } catch (err) {
      if (err instanceof BudgetExceeded || err instanceof SsrfError) throw err;
      return { session: null, issuer: null, error: `the login form post for ${login.email} failed: ${describeError(err)}` };
    }
    applySetCookies(jar, res.setCookies);
    const s = sessionFromCookies(jar);
    if (s) {
      return {
        session: { accessToken: s.accessToken, userId: s.userId, email: s.email ?? login.email, raw: s.raw, cookieHeader: cookieHeaderOf(jar), via: "app-login-form" },
        issuer: s.issuerOrigin,
        error: null,
      };
    }
    const loc = res.headers.location ?? "";
    const why = res.status >= 300 && res.status < 400 && loc && !looksLikeLoginPage(loc) ? "the app redirected but set no Supabase session cookie (sb-<ref>-auth-token)" : "wrong password, or the form needs JavaScript";
    return { session: null, issuer: null, error: `the login form did not sign ${login.email} in (HTTP ${res.status}${loc ? ` → ${loc.slice(0, 80)}` : ""}: ${why})` };
  }
  return { session: null, issuer: null, error: `${problem}: could not sign in as ${login.email}` };
}

/**
 * Signs in the two agents and the manager: through Supabase Auth when a project + key are
 * known, otherwise (or when that fails) through the app's login form. Failures are recorded,
 * never thrown (except running out of time).
 */
export async function signInAll(sb: SupabaseTarget | null, logins: ParsedLogins, form?: { http: Http; base: URL }): Promise<Sessions & { issuers: string[] }> {
  const out: Sessions & { issuers: string[] } = { a: null, b: null, manager: null, errors: [...logins.problems], logins, issuers: [] };
  if (!sb && !form) {
    out.errors.push("no Supabase project to sign in to");
    return out;
  }
  const one = async (l: Login | undefined | null) => {
    if (!l) return null;
    const errs: string[] = [];
    if (sb) {
      try {
        return await sb.probe.signIn(l.email, l.password);
      } catch (err) {
        errs.push(err instanceof ProbeError ? err.message : `sign-in as ${l.email} failed: ${describeError(err)}`);
        // Wrong credentials will not work in the form either.
        if (err instanceof ProbeError && err.status === 400 && sb.verified) {
          out.errors.push(...errs);
          return null;
        }
      }
    }
    if (form) {
      const r = await signInWithForm(form.http, form.base, l);
      if (r.session) {
        if (r.issuer && !out.issuers.includes(r.issuer)) out.issuers.push(r.issuer);
        return r.session;
      }
      if (r.error) errs.push(r.error);
    }
    out.errors.push(...errs);
    return null;
  };
  [out.a, out.b, out.manager] = await Promise.all([one(logins.agents[0]), one(logins.agents[1]), one(logins.manager)]);
  return out;
}

export interface Connection {
  fe: FrontEnd;
  sb: SupabaseTarget | null;
  sbProblem: string | null;
  sbCandidates: string[];
  sessions: Sessions;
  setupErrors: string[];
}

/**
 * Shared setup for the URL and import checks: public crawl → Supabase target → sign-ins →
 * signed-in crawl → (no key yet) look for the key again in what the signed-in pages ship,
 * with the signed-in token's issuer as the likeliest project URL.
 */
export async function connect(
  http: Http,
  base: URL,
  logins: ParsedLogins,
  overrides: { supabaseUrl?: string | null; anonKey?: string | null } = {},
  opts: { crawlSignedIn?: boolean; includeB?: boolean } = {},
): Promise<Connection> {
  const fe = newFrontEnd(base);
  const c: Connection = { fe, sb: null, sbProblem: null, sbCandidates: [], sessions: { a: null, b: null, manager: null, errors: [], logins }, setupErrors: [] };
  const merged = { supabaseUrl: overrides.supabaseUrl || logins.supabaseUrl || null, anonKey: overrides.anonKey || logins.publishableKey || null };
  try {
    await crawlPublic(http, fe);
    let found = await findSupabase(http, fe, merged);
    const signed = await signInAll(found.target, logins, { http, base });
    c.sessions = signed;
    if (opts.crawlSignedIn !== false && (signed.a || signed.manager)) await crawlAuthenticated(http, fe, found.target?.url ?? null, signed, { includeB: opts.includeB ?? !found.target });
    if (!found.target || !found.target.verified) {
      const again = await findSupabase(http, fe, merged, signed.issuers.map((url) => ({ url, via: "token-iss" as const })));
      if (again.target && (!found.target || again.target.verified)) found = again;
      else if (!found.target) found = again;
    }
    c.sb = found.target;
    c.sbProblem = found.problem;
    c.sbCandidates = found.candidates;
    // Sessions from the login form carry a Supabase access token: they work for REST too once the key is known.
    if (c.sb) c.sessions.errors = c.sessions.errors.filter((e) => e !== "no Supabase project to sign in to");
  } catch (err) {
    if (err instanceof BudgetExceeded) throw err;
    c.setupErrors.push(describeError(err));
  }
  return c;
}
