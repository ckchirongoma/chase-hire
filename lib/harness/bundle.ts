import { scanSecrets, type FoundJwt } from "./jwt";

/**
 * Reads a deployed Next.js front end: the same-origin JS chunks a page loads, the internal links
 * worth crawling, and the Supabase project URL + publishable (anon) key the bundle carries, which
 * U3/U4 and the import checks use to talk to the candidate's database as the browser would.
 */

const MAX_URL = 2048;

function sameOrigin(raw: string, base: URL): URL | null {
  if (!raw || raw.length > MAX_URL || raw.startsWith("data:") || raw.startsWith("javascript:")) return null;
  try {
    const u = new URL(raw.replace(/&amp;/g, "&"), base);
    if (u.origin !== base.origin) return null;
    u.hash = "";
    return u;
  } catch {
    return null;
  }
}

/**
 * Same-origin script URLs in a page: <script src>, <link rel=preload|modulepreload as=script>,
 * and /_next/static/....js paths mentioned anywhere (the App Router's RSC payload lists the
 * route's client chunks in inline scripts).
 */
export function extractScriptUrls(html: string, base: URL): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const u = sameOrigin(raw, base);
    if (u && /\.m?js(?:$|\?)/.test(u.pathname + (u.search ? "?" : ""))) out.add(u.toString());
  };
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?(?:preload|modulepreload|prefetch)/i.test(tag)) continue;
    if (/\brel\s*=\s*["']?preload/i.test(tag) && !/\bas\s*=\s*["']?script/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (href) add(href[1]);
  }
  // RSC payloads escape slashes and quotes: unescape before matching.
  const flat = html.replace(/\\\//g, "/").replace(/\\"/g, '"');
  for (const m of flat.matchAll(/\/_next\/static\/[A-Za-z0-9_\-./~%[\]@()]+?\.js\b/g)) add(m[0]);
  for (const m of flat.matchAll(/["'](static\/chunks\/[A-Za-z0-9_\-./~%[\]@()]+?\.js)["']/g)) add(`/_next/${m[1]}`);
  return [...out];
}

/** Same-origin page links (<a href>) worth crawling, without assets, API routes or sign-out links. */
export function extractPageLinks(html: string, base: URL): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    const u = sameOrigin(m[1], base);
    if (!u) continue;
    if (/^\/(?:api|_next|auth\/(?:signout|logout))\b|\/(?:logout|signout|sign-out|log-out)\b/i.test(u.pathname)) continue;
    if (/\.[a-z0-9]{2,5}$/i.test(u.pathname)) continue;
    out.add(u.toString());
  }
  return [...out];
}

export interface SupabaseCandidate {
  url: string;
  /** Why this URL was picked: supabase-host, jwt-ref, csp (connect-src), near-key, any-url. */
  via: "supabase-host" | "jwt-ref" | "csp" | "near-key" | "any-url";
}

export interface SupabaseConfig {
  candidates: SupabaseCandidate[];
  /** The publishable (sb_publishable_…) key, else a legacy anon JWT. */
  key: string | null;
  keyKind: "publishable" | "anon-jwt" | null;
}

const NOT_SUPABASE = /(?:^|\.)(?:googleapis\.com|gstatic\.com|google\.com|openrouter\.ai|github\.com|githubusercontent\.com|vercel\.(?:app|com|live)|nextjs\.org|w3\.org|reactjs\.org|react\.dev|mozilla\.org|schema\.org|sentry\.io|jsdelivr\.net|unpkg\.com|cloudflare\.com|loom\.com|example\.(?:com|org))$/i;

/** http(s) origins allowed by connect-src in Content-Security-Policy headers. */
export function cspConnectOrigins(policies: string[]): string[] {
  const out = new Set<string>();
  for (const p of policies) {
    const directive = p.split(";").map((d) => d.trim()).find((d) => /^connect-src\s/i.test(d));
    for (const src of directive?.split(/\s+/).slice(1) ?? []) {
      const o = originOf(src.replace(/\/\*$/, ""));
      if (o && !o.includes("*")) out.add(o);
    }
  }
  // *.supabase.co first: the likeliest project URL.
  return [...out].sort((a, b) => Number(/\.supabase\.(co|in)$/.test(b)) - Number(/\.supabase\.(co|in)$/.test(a)));
}

function originOf(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Supabase URL candidates and the browser key from the bundle texts, best first:
 * *.supabase.co/.in hosts, then the project ref in the anon JWT, then URLs written next to the
 * key (createClient(url, key) keeps them adjacent after minification), then any other URL.
 */
export function extractSupabaseConfig(texts: string[], deployedOrigin?: string, csp: string[] = []): SupabaseConfig {
  const joined = texts.join("\n");
  const scan = scanSecrets(joined);
  const anon: FoundJwt | undefined = scan.anonJwts[0];
  const key = scan.publishableKeys[0] ?? anon?.token ?? null;
  const keyKind = scan.publishableKeys[0] ? "publishable" : anon ? "anon-jwt" : null;

  const seen = new Set<string>();
  const candidates: SupabaseCandidate[] = [];
  const push = (url: string | null, via: SupabaseCandidate["via"]) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, via });
  };

  const urlRe = /https?:\/\/[A-Za-z0-9.-]+(?::\d{2,5})?(?:\/[^\s"'`<>)\\]*)?/g;
  const all = [...joined.matchAll(urlRe)].map((m) => ({ raw: m[0], index: m.index ?? 0 }));
  for (const u of all) {
    const o = originOf(u.raw);
    if (o && /^https:\/\/[a-z0-9-]+\.supabase\.(?:co|in)$/i.test(o)) push(o, "supabase-host");
  }
  for (const j of scan.anonJwts) if (j.ref && /^[a-z0-9]{10,40}$/i.test(j.ref)) push(`https://${j.ref}.supabase.co`, "jwt-ref");
  // Apps that keep Supabase server-side still name it in their CSP connect-src.
  for (const o of cspConnectOrigins(csp)) if (o !== deployedOrigin && !NOT_SUPABASE.test(new URL(o).hostname)) push(o, "csp");

  if (key) {
    const keyAt: number[] = [];
    for (let i = joined.indexOf(key); i >= 0 && keyAt.length < 20; i = joined.indexOf(key, i + 1)) keyAt.push(i);
    const near = all
      .map((u) => ({ ...u, dist: Math.min(...keyAt.map((k) => Math.abs(k - u.index))) }))
      .filter((u) => u.dist <= 600)
      .sort((a, b) => a.dist - b.dist);
    for (const u of near) {
      const o = originOf(u.raw);
      if (o && !NOT_SUPABASE.test(new URL(o).hostname)) push(o, "near-key");
    }
  }
  for (const u of all) {
    const o = originOf(u.raw);
    if (!o) continue;
    const host = new URL(o).hostname;
    if (NOT_SUPABASE.test(host) || o === deployedOrigin) continue;
    push(o, "any-url");
  }
  return { candidates: candidates.slice(0, 8), key, keyKind };
}
