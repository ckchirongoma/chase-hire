import { z } from "zod";
import { REPO_CHECKS, type CheckResult, type RepoCheckKey } from "./checks";

/**
 * results.json: what the untrusted repo-check job (scripts/verify-swe1/repo-checks.ts) hands to
 * the trusted report job. The untrusted job runs the candidate's code, so the report job treats
 * this file as hostile: only the seven repo check keys, booleans or null, short strings and
 * small flat evidence are accepted, and anything else rejects the whole file.
 */

export const ARTIFACT_SCHEMA = "verify-swe1/1";
export const MAX_ARTIFACT_BYTES = 200_000;

const ShortText = z.string().max(600);
const EvidenceKey = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const Scalar = z.union([ShortText, z.number(), z.boolean(), z.null()]);
const ScalarList = z.array(Scalar).max(60);
const FlatRecord = z.record(EvidenceKey, z.union([Scalar, ScalarList])).refine((r) => Object.keys(r).length <= 40, "too many keys");
const EvidenceValue = z.union([Scalar, ScalarList, FlatRecord, z.array(FlatRecord).max(30)]);
const Evidence = z.record(EvidenceKey, EvidenceValue).refine((r) => Object.keys(r).length <= 40, "too many evidence keys");

export const ArtifactDetail = z.strictObject({
  summary: ShortText.min(1),
  inconclusive: z.literal(true).optional(),
  reason: ShortText.optional(),
  reviewer_note: ShortText.optional(),
  evidence: Evidence.optional(),
});

export const ArtifactCheck = z.strictObject({
  key: z.enum(REPO_CHECKS),
  passed: z.boolean().nullable(),
  detail: ArtifactDetail,
});

export const Artifact = z
  .strictObject({
    schema: z.literal(ARTIFACT_SCHEMA),
    repo_url: z.string().max(200).regex(/^(?:https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}|file:\/\/\/[^\s]{1,190}|\/[^\s]{1,190})$/),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    generated_at: z.iso.datetime({ offset: true }),
    tools: z.record(EvidenceKey, ShortText.max(120)).refine((r) => Object.keys(r).length <= 12, "too many tools").optional(),
    checks: z.array(ArtifactCheck).min(1).max(REPO_CHECKS.length),
  })
  .refine((a) => new Set(a.checks.map((c) => c.key)).size === a.checks.length, { message: "duplicate check keys", path: ["checks"] })
  .refine((a) => a.checks.every((c) => c.passed !== null || c.detail.inconclusive === true), {
    message: "a null result must be marked inconclusive",
    path: ["checks"],
  });
export type Artifact = z.output<typeof Artifact>;

/** Parses and validates raw results.json text. Throws with the first problem. */
export function parseArtifact(raw: string): Artifact {
  if (raw.length > MAX_ARTIFACT_BYTES) throw new Error(`results.json is too large (${raw.length} bytes)`);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("results.json is not valid JSON");
  }
  const res = Artifact.safeParse(json);
  if (!res.success) {
    const issue = res.error.issues[0];
    throw new Error(`results.json failed validation at ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  return res.data;
}

/** Builds the artifact from repo-check results (the CLI's output). Validates before returning. */
export function buildArtifact(input: { repoUrl: string; sha: string; checks: CheckResult[]; tools?: Record<string, string> }): Artifact {
  const doc = {
    schema: ARTIFACT_SCHEMA,
    repo_url: input.repoUrl,
    sha: input.sha,
    generated_at: new Date().toISOString(),
    ...(input.tools ? { tools: input.tools } : {}),
    checks: input.checks.map((c) => ({
      key: c.key as RepoCheckKey,
      passed: c.passed,
      detail: {
        summary: String(c.detail.summary).slice(0, 600),
        ...(c.detail.inconclusive ? { inconclusive: true as const } : {}),
        ...(c.detail.reason ? { reason: String(c.detail.reason).slice(0, 600) } : {}),
        ...(c.detail.reviewer_note ? { reviewer_note: String(c.detail.reviewer_note).slice(0, 600) } : {}),
        ...(c.detail.evidence ? { evidence: flattenEvidence(c.detail.evidence as Record<string, unknown>) } : {}),
      },
    })),
  };
  return parseArtifact(JSON.stringify(doc));
}

/** Coerces evidence into the artifact's bounded shape (deeper values become short strings). */
export function flattenEvidence(ev: Record<string, unknown>): Record<string, unknown> {
  const key = (k: string) => k.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "e_").slice(0, 48) || "e";
  const scalar = (v: unknown): string | number | boolean | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
    if (typeof v === "boolean") return v;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 600 ? `${s.slice(0, 590)}…` : s;
  };
  const list = (v: unknown[]) => v.slice(0, 60).map(scalar);
  const flat = (o: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o).slice(0, 40)) out[key(k)] = Array.isArray(v) ? list(v) : scalar(v);
    return out;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ev).slice(0, 40)) {
    if (Array.isArray(v)) {
      out[key(k)] = v.length && v.every((x) => x && typeof x === "object" && !Array.isArray(x)) ? v.slice(0, 30).map((x) => flat(x as Record<string, unknown>)) : list(v);
    } else if (v && typeof v === "object") out[key(k)] = flat(v as Record<string, unknown>);
    else out[key(k)] = scalar(v);
  }
  return out;
}
