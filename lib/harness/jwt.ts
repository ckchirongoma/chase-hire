/**
 * Finds JWT-looking tokens and Supabase secret keys in text (U2 bundle scan) and decodes JWT
 * payloads without verifying them (we only need the claims: role, ref, iss). Found tokens are
 * never stored in full: `preview` keeps the first 12 characters.
 */

/** Maximal runs of base64url characters and dots: consumed left to right, so the scan is linear. */
const TOKEN_RUN = /[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)*/g;
const SECRET_KEY_RE = /\bsb_secret_[A-Za-z0-9_-]{8,}/g;
const PUBLISHABLE_KEY_RE = /\bsb_publishable_[A-Za-z0-9_-]{8,}/g;

export interface JwtClaims {
  role?: string;
  ref?: string;
  iss?: string;
  [k: string]: unknown;
}

function base64UrlDecode(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    if (typeof atob === "function") {
      const bin = atob(padded);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
    return null;
  } catch {
    return null;
  }
}

/** The payload claims of a JWT, or null if it isn't one. */
export function decodeJwt(token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = base64UrlDecode(parts[0]);
  const payload = base64UrlDecode(parts[1]);
  if (!header || !payload) return null;
  try {
    const h = JSON.parse(header) as unknown;
    const p = JSON.parse(payload) as unknown;
    if (!h || typeof h !== "object" || !p || typeof p !== "object" || Array.isArray(p)) return null;
    return p as JwtClaims;
  } catch {
    return null;
  }
}

export interface FoundJwt {
  preview: string;
  role: string | null;
  ref: string | null;
  iss: string | null;
  /** The full token: callers use it (e.g. as the anon key) but must not store it. */
  token: string;
}

/**
 * JWT-shaped tokens (eyJ<header>.eyJ<payload>.<signature>) in text. A regex like
 * /eyJ[\w-]{5,}\.eyJ…/ backtracks from every "eyJ" to the end of a long run (quadratic on a
 * hostile 2 MB chunk of "eyJeyJ…"), so runs are tokenised once and split on dots instead.
 */
export function jwtCandidates(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN_RUN)) {
    const run = m[0];
    if (!run.includes(".") || !run.includes("eyJ")) continue;
    const parts = run.split(".");
    for (let i = 0; i + 1 < parts.length; i++) {
      const at = parts[i].indexOf("eyJ");
      if (at < 0 || parts[i].length - at < 8 || !parts[i + 1].startsWith("eyJ") || parts[i + 1].length < 8) continue;
      out.push(`${parts[i].slice(at)}.${parts[i + 1]}.${parts[i + 2] ?? ""}`);
      i += 2;
    }
  }
  return out;
}

export function findJwts(text: string): FoundJwt[] {
  const seen = new Set<string>();
  const out: FoundJwt[] = [];
  for (const token of jwtCandidates(text)) {
    if (seen.has(token)) continue;
    seen.add(token);
    const claims = decodeJwt(token);
    if (!claims) continue;
    out.push({
      token,
      preview: `${token.slice(0, 12)}…`,
      role: typeof claims.role === "string" ? claims.role : null,
      ref: typeof claims.ref === "string" ? claims.ref : null,
      iss: typeof claims.iss === "string" ? claims.iss : null,
    });
  }
  return out;
}

export const isServiceRoleJwt = (j: { role: string | null }) => j.role === "service_role" || j.role === "supabase_admin";

/** A key that bypasses RLS (an sb_secret_ key, or a JWT whose role is not anon): never used for probes. */
export function isPrivilegedKey(key: string): boolean {
  if (/^sb_secret_/i.test(key.trim())) return true;
  const claims = key.startsWith("eyJ") ? decodeJwt(key.trim()) : null;
  return !!claims && claims.role !== "anon";
}

export interface SecretScan {
  serviceRoleJwts: { preview: string; role: string | null }[];
  secretKeys: string[];
  /** Other JWT roles seen (anon is expected in a Supabase front end). */
  otherJwtRoles: string[];
  publishableKeys: string[];
  anonJwts: FoundJwt[];
}

/** Scans one text (HTML or JS) for service-role JWTs and sb_secret_ keys. */
export function scanSecrets(text: string): SecretScan {
  const jwts = findJwts(text);
  const secretKeys = [...new Set([...text.matchAll(SECRET_KEY_RE)].map((m) => `${m[0].slice(0, 14)}…`))];
  const publishableKeys = [...new Set([...text.matchAll(PUBLISHABLE_KEY_RE)].map((m) => m[0]))];
  return {
    serviceRoleJwts: jwts.filter(isServiceRoleJwt).map((j) => ({ preview: j.preview, role: j.role })),
    secretKeys,
    otherJwtRoles: [...new Set(jwts.filter((j) => !isServiceRoleJwt(j)).map((j) => j.role ?? "(no role)"))],
    publishableKeys,
    anonJwts: jwts.filter((j) => j.role === "anon"),
  };
}
