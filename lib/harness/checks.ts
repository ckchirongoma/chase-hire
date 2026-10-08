/**
 * SWE Test 1 verification harness: check keys, labels and result shaping (docs/07 "Verification
 * harness", docs/16 check table). Pure: shared by the server checks, the repo-check CLI, the CI
 * report job and the admin panel.
 *
 * Every check produces one verification_runs row: passed true / false, or null when the check is
 * informational (U8) or cannot conclude (then detail.inconclusive = true and detail.reason says
 * why). The grader reads the latest row per key; null counts as "not run", never as a fail.
 *
 * Detail keys are chosen so `summary` sorts near the front of the stored jsonb (Postgres orders
 * object keys by length): the grader quotes only the first few hundred characters.
 */

export const REPO_CHECKS = ["R1", "R2", "R3", "R4", "R5", "R6", "R7"] as const;
export const URL_CHECKS = ["U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8"] as const;
export const IMPORT_CHECKS = ["M1", "M2", "M3", "M4", "M5", "M6", "M7"] as const;
export const DATA_CHECKS = ["D-a", "D-b", "D-c"] as const;
export const CHECK_KEYS = [...REPO_CHECKS, ...URL_CHECKS, ...IMPORT_CHECKS, ...DATA_CHECKS] as const;

export type RepoCheckKey = (typeof REPO_CHECKS)[number];
export type UrlCheckKey = (typeof URL_CHECKS)[number];
export type ImportCheckKey = (typeof IMPORT_CHECKS)[number];
export type DataCheckKey = (typeof DATA_CHECKS)[number];
export type CheckKey = (typeof CHECK_KEYS)[number];

export const isCheckKey = (k: unknown): k is CheckKey => typeof k === "string" && (CHECK_KEYS as readonly string[]).includes(k);

export const CHECK_LABELS: Record<CheckKey, string> = {
  R1: "gitleaks over full history (or rotation documented)",
  R2: "No service-role / secret key in NEXT_PUBLIC_* or 'use client' files",
  R3: "Migrations exist, apply cleanly, every table has RLS",
  R4: "npm ci, lint, tsc --noEmit, build",
  R5: "Tests pass; import and RD-07 covered",
  R6: "CI workflow exists and is green on the SHA",
  R7: ".env* gitignored and .env.example present",
  U1: "GET /api/health is 200 and reports the DB",
  U2: "Bundle scan: no service-role JWT or secret key",
  U3: "Anonymous REST read/insert refused",
  U4: "Agent A cannot read agent B's data",
  U5: "/api/summary burst: 401 anonymous, 429 authenticated",
  U6: "RD-07: call_back without a date refused",
  U7: "RD-11: message to an opted-out customer refused",
  U8: "Security headers (MDN Observatory, informational)",
  M1: "Customer count rises only by the new customers",
  M2: "Sentinel customers' history intact (same IDs)",
  M3: "Changed lines updated, not duplicated",
  M4: "Removed lines marked inactive/ported, not deleted",
  M5: "Quarantine report lists ambiguous/invalid rows",
  M6: "Re-uploading the same file changes nothing",
  M7: "Drift file fails loudly naming the column, no partial data",
  "D-a": "Phones stored as E.164 text; landlines distinguished",
  "D-b": "No expired lines with status InContract",
  "D-c": "No epoch (1970) dates",
};

export type CheckKind = "repo" | "url" | "import" | "data";
export function kindOf(key: CheckKey): CheckKind {
  if (key.startsWith("R")) return "repo";
  if (key.startsWith("U")) return "url";
  if (key.startsWith("M")) return "import";
  return "data";
}

/** Bumped when a check's logic changes, so old and new rows can be told apart. */
export const HARNESS_VERSION = "swe1-harness/1";

export type EvidenceValue = string | number | boolean | null | EvidenceValue[] | { [k: string]: EvidenceValue };
export type Evidence = Record<string, EvidenceValue>;

export interface CheckDetail {
  summary: string;
  /** Set when the check could not conclude (passed = null). */
  inconclusive?: true;
  reason?: string;
  evidence?: Evidence;
  /** Something a reviewer should confirm by hand. */
  reviewer_note?: string;
  [k: string]: unknown;
}

export interface CheckResult {
  key: CheckKey;
  passed: boolean | null;
  detail: CheckDetail;
}

export function pass(key: CheckKey, summary: string, evidence: Evidence = {}, reviewer_note?: string): CheckResult {
  return { key, passed: true, detail: { summary, evidence, ...(reviewer_note ? { reviewer_note } : {}) } };
}

export function fail(key: CheckKey, summary: string, evidence: Evidence = {}, reviewer_note?: string): CheckResult {
  return { key, passed: false, detail: { summary, evidence, ...(reviewer_note ? { reviewer_note } : {}) } };
}

export function inconclusive(key: CheckKey, reason: string, evidence: Evidence = {}): CheckResult {
  return { key, passed: null, detail: { summary: `Inconclusive: ${reason}`, inconclusive: true, reason, evidence } };
}

/** Informational result (U8): recorded, never scored. */
export function informational(key: CheckKey, summary: string, evidence: Evidence = {}): CheckResult {
  return { key, passed: null, detail: { summary, evidence } };
}

// ───────────────────────── Size limits ─────────────────────────

const MAX_STRING = 600;
const MAX_ARRAY = 25;
const MAX_KEYS = 40;
const MAX_DEPTH = 5;
/** Upper bound on one row's detail JSON. */
export const MAX_DETAIL_BYTES = 16_000;

/** Bounds strings, arrays, keys and depth so a hostile app's output cannot bloat a row. */
export function clampValue(v: unknown, depth = 0, maxString = MAX_STRING): EvidenceValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.length > maxString ? `${v.slice(0, maxString)}… (${v.length} chars)` : v;
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "boolean") return v;
  if (depth >= MAX_DEPTH) return "[nested too deep]";
  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_ARRAY).map((x) => clampValue(x, depth + 1, maxString));
    if (v.length > MAX_ARRAY) out.push(`… ${v.length - MAX_ARRAY} more`);
    return out;
  }
  if (typeof v === "object") {
    const out: Record<string, EvidenceValue> = {};
    const entries = Object.entries(v as Record<string, unknown>);
    for (const [k, x] of entries.slice(0, MAX_KEYS)) out[k.slice(0, 80)] = clampValue(x, depth + 1, maxString);
    if (entries.length > MAX_KEYS) out["…"] = `${entries.length - MAX_KEYS} more keys`;
    return out;
  }
  return String(v).slice(0, maxString);
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/**
 * The jsonb stored for one result: the detail plus run metadata, clamped and, if still too big,
 * with the evidence cut down step by step (strings shortened, then evidence dropped).
 */
export function shapeDetail(r: CheckResult, meta: Record<string, unknown> = {}): Record<string, unknown> {
  const build = (maxString: number, keepEvidence: boolean) => {
    const { evidence, ...rest } = r.detail;
    const base = clampValue({ ...rest, ...meta }, 0, maxString) as Record<string, EvidenceValue>;
    if (keepEvidence && evidence) base.evidence = clampValue(evidence, 1, maxString);
    else if (evidence) base.evidence = { note: "evidence dropped: too large to store" };
    return base;
  };
  for (const [len, keep] of [
    [MAX_STRING, true],
    [200, true],
    [80, true],
    [200, false],
  ] as const) {
    const d = build(len, keep);
    if (byteLength(JSON.stringify(d)) <= MAX_DETAIL_BYTES) return d;
  }
  return { summary: String(r.detail.summary).slice(0, 300), evidence: { note: "detail too large to store" } };
}

/** One verification_runs row (service-role insert; manual = false). */
export function toRunRow(
  submissionId: string,
  r: CheckResult,
  opts: { ranBy?: string | null; meta?: Record<string, unknown> } = {},
): { submission_id: string; check_key: CheckKey; passed: boolean | null; manual: false; detail: Record<string, unknown>; ran_by: string | null } {
  return {
    submission_id: submissionId,
    check_key: r.key,
    passed: r.passed,
    manual: false,
    detail: shapeDetail(r, { version: HARNESS_VERSION, ...opts.meta }),
    ran_by: opts.ranBy ?? null,
  };
}

/** Redacts JWTs and secret-looking keys from free text before it is stored as evidence. */
export function redactSecrets(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, (m) => `${m.slice(0, 12)}…[jwt redacted]`)
    .replace(/\bsb_secret_[A-Za-z0-9_-]{4,}/g, "sb_secret_…[redacted]")
    .replace(/\b(sk-[A-Za-z0-9-]{2,8})[A-Za-z0-9_-]{16,}/g, "$1…[redacted]")
    .replace(/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, "$1…[redacted]");
}

/** A short, safe snippet of a response body for evidence. */
export function snippet(text: string, max = 300): string {
  const clean = redactSecrets(text.replace(/\s+/g, " ").trim());
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
