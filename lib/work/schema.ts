import { z } from "zod";
import { DRAFT_MAX_BYTES, MAX_EXTRA_FILES, MAX_TRANSCRIPT_CHARS, type StageKey } from "./stages";
import { parseGithubRepo, parseHttpsUrl } from "./url";

/**
 * Request schemas for the work API. The stage is always taken from the attempt on the server;
 * the client never says which stage it is submitting for.
 */

const HttpsUrl = z
  .string()
  .trim()
  .min(1, "Add the link")
  .max(2048, "That link is too long")
  .refine((v) => parseHttpsUrl(v) !== null, "Use a full, public https:// link")
  .transform((v) => parseHttpsUrl(v)!.toString());

const RepoUrl = z
  .string()
  .trim()
  .min(1, "Add the repository URL")
  .refine((v) => parseGithubRepo(v) !== null, "Use the repository's address, like https://github.com/owner/repo")
  .transform((v) => parseGithubRepo(v)!.url);

const Transcript = z
  .string()
  .trim()
  .min(20, "Paste the Loom transcript (at least a few sentences)")
  .max(MAX_TRANSCRIPT_CHARS, `The transcript can be at most ${MAX_TRANSCRIPT_CHARS.toLocaleString("en-US")} characters`);

/** A storage path in the submissions bucket; ownership and existence are checked on the server. */
const FilePath = z
  .string()
  .trim()
  .min(1, "Upload the file")
  .max(500)
  .refine((v) => !v.includes("..") && !v.startsWith("/") && !v.includes("\\"), "Invalid file path");

const TestLogins = z
  .string()
  .trim()
  .min(10, "Add the test logins (two agents and one manager)")
  .max(4000, "Keep the test logins under 4,000 characters");

export const SubmissionSchemas = {
  ba_part1: z.strictObject({ memo: FilePath }),
  ba_part2: z.strictObject({
    mvp_url: HttpsUrl,
    handoff: FilePath,
    extras: z.array(FilePath).max(MAX_EXTRA_FILES, `At most ${MAX_EXTRA_FILES} extra files`).default([]),
    loom_url: HttpsUrl,
    loom_transcript: Transcript,
  }),
  swe_test1: z.strictObject({
    repo_url: RepoUrl,
    deployed_url: HttpsUrl,
    test_logins: TestLogins,
    loom_url: HttpsUrl,
    loom_transcript: Transcript,
  }),
  swe_test2: z.strictObject({ memo: FilePath, loom_url: HttpsUrl, loom_transcript: Transcript }),
} as const satisfies Record<StageKey, z.ZodType>;

export type SubmissionInput = {
  [K in StageKey]: z.output<(typeof SubmissionSchemas)[K]>;
};
export type AnySubmissionInput = SubmissionInput[StageKey];

/** Validates a submission body for a stage; returns the first problem as a readable message. */
export function parseSubmission<K extends StageKey>(
  key: K,
  body: unknown,
): { ok: true; data: SubmissionInput[K] } | { ok: false; error: string; field: string | null } {
  const res = SubmissionSchemas[key].safeParse(body ?? {});
  if (res.success) return { ok: true, data: res.data as SubmissionInput[K] };
  const issue = res.error.issues[0];
  const field = typeof issue?.path?.[0] === "string" ? (issue.path[0] as string) : null;
  const message =
    issue?.code === "unrecognized_keys"
      ? "The form sent a field this stage doesn't take. Reload the page and try again."
      : issue?.code === "invalid_type" && field
        ? `Missing: ${field.replace(/_/g, " ")}`
        : (issue?.message ?? "Invalid submission");
  return { ok: false, error: message, field };
}

/** Autosaved draft: field name → text, or a list of uploaded storage paths. */
export const DraftSchema = z
  .record(z.string().regex(/^[a-z][a-z_]{0,39}$/), z.union([z.string().max(MAX_TRANSCRIPT_CHARS), z.array(z.string().max(500)).max(MAX_EXTRA_FILES + 1)]))
  .refine((d) => Object.keys(d).length <= 20, "Too many draft fields")
  .refine((d) => new TextEncoder().encode(JSON.stringify(d)).length <= DRAFT_MAX_BYTES, "Your draft is too large to autosave (50 KB)");
export type Draft = z.output<typeof DraftSchema>;

export const DraftBody = z.strictObject({ draft: DraftSchema });
