/**
 * Finds JWT-looking tokens and Supabase secret keys in text (U2 bundle scan) and decodes JWT
 * payloads without verifying them (we only need the claims: role, ref, iss). Found tokens are
 * never stored in full: `preview` keeps the first 12 characters.
 */

const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{0,}/g;
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

export function findJwts(text: string): FoundJwt[] {
  const seen = new Set<string>();
  const out: FoundJwt[] = [];
  for (const m of text.matchAll(JWT_RE)) {
    const token = m[0];
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
