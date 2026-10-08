import "server-only";
import { extractPageLinks, extractScriptUrls, extractSupabaseConfig } from "./bundle";
import { describeError, mapPool, type Http } from "./http";
import { appAuthHeaders, ProbeError, SupabaseProbe, type Session } from "./supabase";
import type { Login, ParsedLogins } from "./logins";

/**
 * Crawls the candidate's deployed front end (public pages first, then as the test users) and
 * collects every same-origin JS chunk, so U2 can scan them and U3/U4/import checks can find the
 * Supabase URL and publishable key the browser uses.
 */

export const CRAWL_LIMITS = { pages: 14, scripts: 70, scriptBytes: 2 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 } as const;
const GUESSED_PATHS = ["/", "/login", "/queue", "/renewals", "/customers", "/dashboard", "/manager", "/import", "/imports", "/messages", "/admin"];

export interface FetchedText {
  url: string;
  status: number | null;
  bytes: number;
  truncated: boolean;
  error: string | null;
  /** Which session fetched it (for pages). */
  as: string;
}

export interface FrontEnd {
  base: URL;
  pages: FetchedText[];
  scripts: FetchedText[];
  /** url → text, for scanning (not stored). */
  texts: Map<string, string>;
  totalBytes: number;
  limitsHit: string[];
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
  return { base, pages: [], scripts: [], texts: new Map(), totalBytes: 0, limitsHit: [] };
}

async function fetchText(http: Http, fe: FrontEnd, url: string, headers: Record<string, string>, maxBytes: number, as: string, follow: number): Promise<FetchedText & { text: string | null; finalUrl: string }> {
  try {
    const res = await http.request(url, { headers: { accept: "text/html,application/javascript,*/*;q=0.5", ...headers }, maxBytes, timeoutMs: 12_000, followRedirects: follow });
    const text = res.status >= 200 && res.status < 300 ? res.text() : null;
    if (text) fe.totalBytes += res.body.length;
    return { url, status: res.status, bytes: res.body.length, truncated: res.truncated, error: null, as, text, finalUrl: res.url };
  } catch (err) {
    return { url, status: null, bytes: 0, truncated: false, error: describeError(err), as, text: null, finalUrl: url };
  }
}

/**
 * Fetches pages as one session (or anonymously), at most CRAWL_LIMITS.pages per session, then
 * their not-yet-seen scripts. With discoverLinks, links found on the first round are fetched
 * in a second round (one level deep).
 */
export async function crawl(http: Http, fe: FrontEnd, paths: string[], opts: { headers?: Record<string, string>; as: string; discoverLinks?: boolean }): Promise<void> {
  const headers = opts.headers ?? {};
  const seen = () => new Set(fe.pages.filter((p) => p.as === opts.as).map((p) => p.url));
  const scripts: string[] = [];
  let round = [...new Set(paths.map((p) => new URL(p, fe.base).toString()))];
  for (let depth = 0; depth < (opts.discoverLinks ? 2 : 1) && round.length; depth++) {
    const done = seen();
    const room = Math.max(0, CRAWL_LIMITS.pages - done.size);
    const todo = round.filter((u) => !done.has(u));
    if (todo.length > room && !fe.limitsHit.includes(`pages capped at ${CRAWL_LIMITS.pages} (${opts.as})`)) fe.limitsHit.push(`pages capped at ${CRAWL_LIMITS.pages} (${opts.as})`);
    const fetched = await mapPool(todo.slice(0, room), 4, (u) => fetchText(http, fe, u, headers, CRAWL_LIMITS.scriptBytes, opts.as, 3));
    const links: string[] = [];
    for (const p of fetched) {
      const { text, finalUrl, ...meta } = p;
      fe.pages.push(meta);
      if (!text) continue;
      fe.texts.set(`${finalUrl}#${opts.as}`, text);
      for (const s of extractScriptUrls(text, new URL(finalUrl))) if (!scripts.includes(s)) scripts.push(s);
      for (const l of extractPageLinks(text, new URL(finalUrl))) if (!links.includes(l)) links.push(l);
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

/** Authenticated crawl: guessed app paths and links, as each session that signed in. */
export async function crawlAuthenticated(http: Http, fe: FrontEnd, sb: SupabaseTarget, sessions: Sessions): Promise<void> {
  for (const [as, s] of [
    ["agent_a", sessions.a],
    ["manager", sessions.manager],
  ] as const) {
    if (!s) continue;
    await crawl(http, fe, GUESSED_PATHS, { headers: appAuthHeaders(sb.url, s), as, discoverLinks: true });
  }
}

/**
 * Picks the Supabase project: admin overrides first, else bundle candidates verified with
 * GET /auth/v1/settings (the first that answers like Supabase wins; unverified best guess
 * otherwise).
 */
export async function findSupabase(http: Http, fe: FrontEnd, overrides: { supabaseUrl?: string | null; anonKey?: string | null } = {}): Promise<{ target: SupabaseTarget | null; problem: string | null; candidates: string[] }> {
  const cfg = extractSupabaseConfig([...fe.texts.values()], fe.base.origin);
  const key = overrides.anonKey || cfg.key;
  const candidates = overrides.supabaseUrl ? [{ url: overrides.supabaseUrl.replace(/\/+$/, ""), via: "admin override" }, ...cfg.candidates] : cfg.candidates;
  if (!key) return { target: null, problem: "no publishable/anon key found in the bundle (enter it in the harness form)", candidates: candidates.map((c) => c.url) };
  if (!candidates.length) return { target: null, problem: "no Supabase URL found in the bundle (enter it in the harness form)", candidates: [] };
  const keyKind = overrides.anonKey ? "admin override" : (cfg.keyKind ?? "unknown");
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

/** Signs in the two agents and the manager. Failures are recorded, never thrown. */
export async function signInAll(sb: SupabaseTarget | null, logins: ParsedLogins): Promise<Sessions> {
  const out: Sessions = { a: null, b: null, manager: null, errors: [...logins.problems], logins };
  if (!sb) {
    out.errors.push("no Supabase project to sign in to");
    return out;
  }
  const one = async (l: Login | undefined | null) => {
    if (!l) return null;
    try {
      return await sb.probe.signIn(l.email, l.password);
    } catch (err) {
      out.errors.push(err instanceof ProbeError ? err.message : `sign-in as ${l.email} failed: ${describeError(err)}`);
      return null;
    }
  };
  [out.a, out.b, out.manager] = await Promise.all([one(logins.agents[0]), one(logins.agents[1]), one(logins.manager)]);
  return out;
}
