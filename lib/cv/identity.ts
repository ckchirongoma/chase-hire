import { createHash } from "node:crypto";

/** Identity normalisers used by the dedupe layer (docs/01 §3). Each returns null for unusable input. */

type Maybe = string | null | undefined;

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[a-z]{2,}$/;

export function normaliseEmail(s: Maybe): string | null {
  if (!s) return null;
  const email = s.trim().replace(/^mailto:/i, "").toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

/**
 * Stricter key for duplicate detection: drops "+tag" sub-addressing on any domain and dots in
 * Gmail local parts, so test.candidate+2@gmail.com matches testcandidate@gmail.com.
 */
export function emailDedupeKey(s: Maybe): string | null {
  const email = normaliseEmail(s);
  if (!email) return null;
  const at = email.lastIndexOf("@");
  let local = email.slice(0, at).replace(/\+.*$/, "");
  let domain = email.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return local ? `${local}@${domain}` : null;
}

/**
 * Normalises a phone number to E.164, assuming South Africa (+27) when no country code is given.
 * Handles "(083) 272 8600", "083 272 8600", "0832728600", "832728600", "+27 83 272 8600",
 * "+27 (0)83 272 8600", "27832728600", "0027 83 272 8600" and landlines ("021 555 1234").
 * A number already in international form for another country is returned as +<digits>.
 */
export function normalisePhoneZA(s: Maybe): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  let international = trimmed.startsWith("+");
  if (!international && digits.startsWith("00")) {
    international = true;
    digits = digits.slice(2);
  }

  let national: string;
  if (international) {
    if (!digits.startsWith("27")) {
      return digits.length >= 8 && digits.length <= 15 && digits[0] !== "0" ? `+${digits}` : null;
    }
    national = digits.slice(2);
  } else if (digits.startsWith("27") && digits.length === 11) {
    national = digits.slice(2);
  } else if (digits.startsWith("0") && digits.length === 10) {
    national = digits.slice(1);
  } else if (digits.length === 9 && /^[678]/.test(digits)) {
    national = digits; // mobile written without the trunk 0
  } else {
    return null;
  }

  // "+27 (0)83 ..." keeps the trunk 0 after the country code.
  if (national.length === 10 && national.startsWith("0")) national = national.slice(1);
  if (!/^[1-8]\d{8}$/.test(national)) return null;
  return `+27${national}`;
}

/** True for South African mobile numbers in E.164 (+276x, +277x, +278x). */
export function isZaMobile(e164: Maybe): boolean {
  return !!e164 && /^\+27[678]\d{8}$/.test(e164);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Lowercase LinkedIn handle from a linkedin.com/in/<handle> URL (with or without protocol/www), else null. */
export function linkedinHandle(url: Maybe): string | null {
  const m = url?.trim().match(/(?:^|[^a-z0-9-])linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!m) return null;
  const h = safeDecode(m[1]).toLowerCase();
  return /^[\p{L}\p{N}_-]{3,100}$/u.test(h) ? h : null;
}

/** Non-user first path segments on github.com. */
const GITHUB_RESERVED = new Set([
  "orgs", "features", "about", "login", "join", "settings", "topics", "marketplace", "sponsors",
  "collections", "explore", "apps", "enterprise", "pricing", "search", "notifications", "issues",
  "pulls", "trending", "site", "security", "customer-stories", "readme", "events", "codespaces",
]);

/** Lowercase GitHub username: the first path segment of a github.com URL, else null. */
export function githubHandle(url: Maybe): string | null {
  const m = url?.trim().match(/(?:^|[^a-z0-9-])github\.com\/([^/?#\s]+)/i);
  if (!m) return null;
  const h = m[1].toLowerCase();
  if (GITHUB_RESERVED.has(h)) return null;
  return /^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(h) ? h : null;
}

/** Text fed to the embeddings model for semantic dedupe: lowercase, single-spaced, ≤ 8000 chars. */
export function normaliseCvTextForEmbedding(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 8000);
}

export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}
