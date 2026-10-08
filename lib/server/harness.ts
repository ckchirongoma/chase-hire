import "server-only";
import { NextResponse } from "next/server";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { z } from "zod";
import { CHECK_KEYS, holdBackInconclusive, kindOf, latestByKey, toRunRow, type CheckKey, type CheckResult, type StoredRun } from "@/lib/harness/checks";
import { BUNDLE_FILES, HarnessExpected, optoutEntries, optoutEntriesFromSheet, type OptoutEntry } from "@/lib/harness/expected";
import { dispatchConfig, dispatchWorkflow, localRepoCheckCommands } from "@/lib/harness/github";
import { isPrivilegedKey } from "@/lib/harness/jwt";
import { Budget, createHttp } from "@/lib/harness/http";
import { runImportChecks } from "@/lib/harness/import-checks";
import { parseTestLogins } from "@/lib/harness/logins";
import { runUrlChecks } from "@/lib/harness/url-checks";
import { readFirstSheet } from "@/lib/harness/xlsx-lite";
import { isAdmin } from "@/lib/server/auth";
import { enqueueGrading, runGradingJob, type JobRun } from "@/lib/server/grading";
import { routeUser } from "@/lib/server/route";

/**
 * SWE Test 1 verification harness, server side (docs/07 "Verification harness", docs/16).
 * The admin panel's buttons call the routes under app/api/admin/harness/[submissionId]/…,
 * which call these functions:
 *
 * - runUrlHarness: U1–U8 against the deployed URL (reads, plus a few labelled probe rows).
 * - runImportHarness: M1–M7 and D-a..D-c as the manager login; uploads the held-back month-2
 *   files to the candidate's app, so it mutates their database (the admin confirms first).
 * - dispatchRepoHarness: R1–R7 run in GitHub Actions (.github/workflows/verify-swe1.yml) when
 *   GITHUB_ACTIONS_TOKEN and GITHUB_ACTIONS_REPO are set; otherwise the panel shows the local
 *   commands (scripts/verify-swe1/).
 *
 * Results are verification_runs rows (one per check, latest wins in the grader). An inconclusive
 * result never replaces a conclusive or manual one (it is noted in harness_runs.summary instead).
 * Scores stay advisory: nothing here changes an application's status. harness_runs (migration
 * 0015) logs each run and stops two runs of the same kind overlapping on one submission.
 */

export class HarnessError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const URL_BUDGET_MS = 265_000;
export const IMPORT_BUDGET_MS = 270_000;
/** A run older than this is assumed dead (the function hit maxDuration) and its lock is released. */
const STALE_RUN_MS = 7 * 60_000;
const DEFAULT_BUNDLE = "v1/bundle_c";

export type HarnessKind = "url" | "import" | "repo";

export interface HarnessSubmission {
  id: string;
  stageKey: string;
  repoUrl: string | null;
  sha: string | null;
  deployedUrl: string | null;
  testLogins: string | null;
  bundlePrefix: string;
}

export async function loadHarnessSubmission(admin: SupabaseClient, submissionId: string): Promise<HarnessSubmission> {
  const { data, error } = await admin
    .from("submissions")
    .select("id, stage_key, repo_url, repo_commit_sha, deployed_url, test_logins, snapshot, work_attempts(work_stages(dataset_bundle))")
    .eq("id", submissionId)
    .maybeSingle();
  if (error) throw new HarnessError(`could not read the submission: ${error.message}`, 500);
  if (!data) throw new HarnessError("Submission not found", 404);
  if (data.stage_key !== "swe_test1") throw new HarnessError("The verification harness is for SWE Test 1 submissions only", 400);
  const attempt = data.work_attempts as unknown as { work_stages: { dataset_bundle: string | null } | null } | null;
  const snapshot = (data.snapshot ?? {}) as { repo?: { sha?: string | null } };
  return {
    id: data.id as string,
    stageKey: data.stage_key as string,
    repoUrl: (data.repo_url as string | null) ?? null,
    sha: (data.repo_commit_sha as string | null) ?? snapshot.repo?.sha ?? null,
    deployedUrl: (data.deployed_url as string | null) ?? null,
    testLogins: (data.test_logins as string | null) ?? null,
    bundlePrefix: (attempt?.work_stages?.dataset_bundle ?? DEFAULT_BUNDLE).replace(/\/+$/, ""),
  };
}

async function download(admin: SupabaseClient, path: string): Promise<Buffer | null> {
  const { data, error } = await admin.storage.from("datasets").download(path);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

/** The bundle's internal expected_month2.json, or null when it is not uploaded. */
export async function loadExpected(admin: SupabaseClient, prefix: string): Promise<HarnessExpected | null> {
  const raw = await download(admin, `${prefix}/${BUNDLE_FILES.expected}`);
  if (!raw) return null;
  const parsed = HarnessExpected.safeParse(JSON.parse(raw.toString("utf8")));
  if (!parsed.success) throw new HarnessError(`datasets/${prefix}/${BUNDLE_FILES.expected} does not match the harness's expectations: ${parsed.error.issues[0]?.message}`, 500);
  return parsed.data;
}

/**
 * The opt-out list for U7: the candidate's optouts_legal.xlsx (names only, as the app must
 * match them), enriched with the answer key's registration numbers; else the answer key's list.
 */
export async function loadOptouts(admin: SupabaseClient, prefix: string, expected: HarnessExpected | null): Promise<{ entries: OptoutEntry[]; source: string }> {
  const raw = await download(admin, `${prefix}/${BUNDLE_FILES.optouts}`);
  if (raw) {
    try {
      const entries = optoutEntriesFromSheet(readFirstSheet(raw), expected);
      if (entries?.length) return { entries, source: `bundle ${BUNDLE_FILES.optouts} (${entries.length} names)` };
    } catch (err) {
      console.warn("harness: could not read the opt-out sheet:", (err as Error).message);
    }
  }
  const entries = optoutEntries(expected);
  return { entries, source: entries.length ? `answer key opt-out list (${entries.length} names)` : "none" };
}

// ───────────────────────── Run log / lock ─────────────────────────

async function startRun(admin: SupabaseClient, submissionId: string, kind: HarnessKind, ranBy: string | null, status: "running" | "dispatched" = "running"): Promise<string> {
  await admin
    .from("harness_runs")
    .update({ status: "failed", finished_at: new Date().toISOString(), summary: { error: "did not finish (timed out or the server stopped)" } })
    .eq("submission_id", submissionId)
    .eq("kind", kind)
    .eq("status", "running")
    .lt("started_at", new Date(Date.now() - STALE_RUN_MS).toISOString());
  const { data, error } = await admin.from("harness_runs").insert({ submission_id: submissionId, kind, status, ran_by: ranBy }).select("id").single();
  if (error?.code === "23505") throw new HarnessError(`The ${kind === "url" ? "URL" : kind} checks are already running for this submission. Wait for them to finish.`, 409);
  if (error || !data) throw new HarnessError(`could not start the harness run: ${error?.message ?? "no row"}`, 500);
  return data.id as string;
}

async function finishRun(admin: SupabaseClient, runId: string, status: "done" | "failed", summary: Record<string, unknown>) {
  await admin.from("harness_runs").update({ status, finished_at: new Date().toISOString(), summary }).eq("id", runId);
}

type Kept = { key: CheckKey; reason: string }[];

/**
 * Writes one verification_runs row per result, except inconclusive results for checks whose
 * latest row is conclusive or manual (see holdBackInconclusive): those are returned as `kept`.
 */
async function writeResults(admin: SupabaseClient, submissionId: string, results: CheckResult[], meta: { ranBy: string | null; runId: string; target: string | null; startedAt: number }): Promise<Kept> {
  if (!results.length) return [];
  const { data: stored, error: readError } = await admin
    .from("verification_runs")
    .select("check_key, passed, manual, detail")
    .eq("submission_id", submissionId)
    .in("check_key", results.map((r) => r.key))
    .order("ran_at", { ascending: false });
  if (readError) throw new HarnessError(`could not read earlier results: ${readError.message}`, 500);
  const { write, kept } = holdBackInconclusive(results, latestByKey((stored ?? []) as StoredRun[]));
  if (write.length) {
    const rows = write.map((r) => toRunRow(submissionId, r, { ranBy: meta.ranBy, meta: { harness_run: meta.runId, target_url: meta.target, duration_ms: Date.now() - meta.startedAt } }));
    const { error } = await admin.from("verification_runs").insert(rows);
    if (error) throw new HarnessError(`could not store the results: ${error.message}`, 500);
  }
  return kept;
}

const tally = (results: CheckResult[], kept: Kept = []) => ({
  passed: results.filter((r) => r.passed === true).map((r) => r.key),
  failed: results.filter((r) => r.passed === false).map((r) => r.key),
  inconclusive: results.filter((r) => r.passed === null && !kept.some((k) => k.key === r.key)).map((r) => r.key),
  kept: kept.map((k) => k.key),
});

export interface HarnessRunSummary {
  runId: string;
  results: { key: CheckKey; passed: boolean | null; summary: string }[];
  skipped: CheckKey[];
  passed: CheckKey[];
  failed: CheckKey[];
  /** Inconclusive this run, and written (no earlier conclusive result). */
  inconclusive: CheckKey[];
  /** Inconclusive this run, not written: the earlier conclusive or manual result stands. */
  kept: CheckKey[];
}

const brief = (r: CheckResult) => ({ key: r.key, passed: r.passed, summary: String(r.detail.summary).slice(0, 300) });

export interface RunOptions {
  ranBy: string | null;
  overrides?: { supabaseUrl?: string | null; anonKey?: string | null };
  /** Tests only: read the bundle from another prefix. */
  bundlePrefix?: string;
  budgetMs?: number;
  observatoryUrl?: string;
  /** Tests only: re-count every N ms while an import settles (default 2.5 s). */
  settlePollMs?: number;
}

/** Admin-entered Supabase URL/key win over what the candidate wrote next to the logins. */
function mergeOverrides(o: RunOptions["overrides"], logins: ReturnType<typeof parseTestLogins>) {
  return { supabaseUrl: o?.supabaseUrl || logins.supabaseUrl || null, anonKey: o?.anonKey || logins.publishableKey || null };
}

/** U1–U8. Writes one verification_runs row per check. */
export async function runUrlHarness(admin: SupabaseClient, submissionId: string, opts: RunOptions): Promise<HarnessRunSummary> {
  const sub = await loadHarnessSubmission(admin, submissionId);
  const runId = await startRun(admin, submissionId, "url", opts.ranBy);
  const startedAt = Date.now();
  try {
    const prefix = opts.bundlePrefix ?? sub.bundlePrefix;
    const expected = await loadExpected(admin, prefix).catch(() => null);
    const optouts = await loadOptouts(admin, prefix, expected);
    const http = createHttp({ budget: new Budget(opts.budgetMs ?? URL_BUDGET_MS) });
    const logins = parseTestLogins(sub.testLogins);
    const { results, context } = sub.deployedUrl
      ? await runUrlChecks({
          http,
          deployedUrl: sub.deployedUrl,
          logins,
          optouts: optouts.entries,
          optoutSource: optouts.source,
          overrides: mergeOverrides(opts.overrides, logins),
          observatoryUrl: opts.observatoryUrl ?? process.env.HARNESS_OBSERVATORY_URL ?? undefined,
        })
      : { results: (["U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8"] as const).map((key) => ({ key, passed: null, detail: { summary: "Inconclusive: no deployed URL was submitted", inconclusive: true as const, reason: "no deployed URL was submitted" } })), context: {} };
    const kept = await writeResults(admin, submissionId, results, { ranBy: opts.ranBy, runId, target: sub.deployedUrl, startedAt });
    const t = tally(results, kept);
    await finishRun(admin, runId, "done", { ...t, kept_earlier: kept, context, opt_out_list: optouts.source });
    return { runId, results: results.map(brief), skipped: [], ...t };
  } catch (err) {
    await finishRun(admin, runId, "failed", { error: err instanceof Error ? err.message.slice(0, 500) : String(err) });
    throw err;
  }
}

/** M1–M7 and D-a..D-c. Mutates the candidate's deployment (uploads month 2 twice and the drift file). */
export async function runImportHarness(admin: SupabaseClient, submissionId: string, opts: RunOptions): Promise<HarnessRunSummary> {
  const sub = await loadHarnessSubmission(admin, submissionId);
  if (!sub.deployedUrl) throw new HarnessError("No deployed URL was submitted", 409);
  const prefix = opts.bundlePrefix ?? sub.bundlePrefix;
  const [expected, month2, drift] = await Promise.all([loadExpected(admin, prefix), download(admin, `${prefix}/${BUNDLE_FILES.month2}`), download(admin, `${prefix}/${BUNDLE_FILES.drift}`)]);
  if (!expected || !month2 || !drift) {
    throw new HarnessError(`The month-2 files are missing from datasets/${prefix}/internal/ (expected_month2.json, base_month2.xlsx, base_month2_drift.xlsx). Upload the bundle with scripts/synth/upload.ts.`, 409);
  }
  const runId = await startRun(admin, submissionId, "import", opts.ranBy);
  const startedAt = Date.now();
  try {
    const http = createHttp({ budget: new Budget(opts.budgetMs ?? IMPORT_BUDGET_MS) });
    const logins = parseTestLogins(sub.testLogins);
    const run = await runImportChecks({ http, deployedUrl: sub.deployedUrl, logins, expected, files: { month2, drift }, overrides: mergeOverrides(opts.overrides, logins), settlePollMs: opts.settlePollMs });
    const kept = await writeResults(admin, submissionId, run.results, { ranBy: opts.ranBy, runId, target: sub.deployedUrl, startedAt });
    const t = tally(run.results, kept);
    await finishRun(admin, runId, "done", { ...t, kept_earlier: kept, skipped: run.skipped, context: run.context });
    return { runId, results: run.results.map(brief), skipped: run.skipped, ...t };
  } catch (err) {
    await finishRun(admin, runId, "failed", { error: err instanceof Error ? err.message.slice(0, 500) : String(err) });
    throw err;
  }
}

export interface RepoDispatch {
  dispatched: boolean;
  runUrl: string | null;
  commands: string[];
  message: string;
}

/** R1–R7: dispatch the GitHub workflow, or hand back the local commands. */
export async function dispatchRepoHarness(admin: SupabaseClient, submissionId: string, ranBy: string | null): Promise<RepoDispatch> {
  const sub = await loadHarnessSubmission(admin, submissionId);
  if (!sub.repoUrl) throw new HarnessError("No repository URL was submitted", 409);
  if (!sub.sha || !/^[0-9a-f]{40}$/.test(sub.sha)) throw new HarnessError("No commit SHA was recorded for this submission, so there is nothing fixed to check. Record the result by hand.", 409);
  const commands = localRepoCheckCommands({ submissionId, repoUrl: sub.repoUrl, sha: sub.sha });
  const cfg = dispatchConfig();
  if (!cfg) return { dispatched: false, runUrl: null, commands, message: "GitHub dispatch is not configured (GITHUB_ACTIONS_TOKEN, GITHUB_ACTIONS_REPO): run the commands locally." };
  const runId = await startRun(admin, submissionId, "repo", ranBy, "dispatched");
  try {
    const { runUrl } = await dispatchWorkflow(cfg, { submission_id: submissionId, repo_url: sub.repoUrl, sha: sub.sha, harness_run_id: runId });
    await admin.from("harness_runs").update({ summary: { workflow_repo: cfg.repo, ref: cfg.ref, run_url: runUrl } }).eq("id", runId);
    return { dispatched: true, runUrl, commands, message: `Repo checks dispatched to ${cfg.repo} (${cfg.workflow}). Results appear here when the workflow finishes (usually 10–25 minutes).` };
  } catch (err) {
    await finishRun(admin, runId, "failed", { error: (err as Error).message.slice(0, 500) });
    throw new HarnessError((err as Error).message, 502);
  }
}

/** Re-grade the submission so the SWE1 grader reads the latest harness rows. */
export async function regradeWithHarness(admin: SupabaseClient, submissionId: string): Promise<JobRun> {
  await loadHarnessSubmission(admin, submissionId);
  const jobId = await enqueueGrading(admin, "submission", submissionId);
  return runGradingJob(admin, jobId);
}

// ───────────────────────── Manual results ─────────────────────────

export const ManualResult = z.object({
  check_key: z.enum(CHECK_KEYS),
  result: z.enum(["pass", "fail", "info"]),
  note: z.string().trim().min(10, "Write a note of at least 10 characters: what you checked and what you saw.").max(2000),
});

/**
 * Records a reviewer's result through the admin's OWN session: RLS allows admins to insert
 * manual rows only, with ran_by = themselves (migration 0011).
 */
export async function recordManualResult(userClient: SupabaseClient, user: User, submissionId: string, input: z.output<typeof ManualResult>): Promise<void> {
  const passed = input.result === "pass" ? true : input.result === "fail" ? false : null;
  const { error } = await userClient.from("verification_runs").insert({
    submission_id: submissionId,
    check_key: input.check_key,
    passed,
    manual: true,
    ran_by: user.id,
    detail: { summary: input.note, reviewer: user.email ?? user.id, kind: kindOf(input.check_key), recorded_at: new Date().toISOString() },
  });
  if (error) throw new HarnessError(`could not record the result: ${error.message}`, error.code === "42501" ? 403 : 400);
}

// ───────────────────────── Route plumbing ─────────────────────────

export const SubmissionIdParam = z.uuid();

export const Overrides = z.object({
  supabase_url: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((v) => v || undefined)
    .pipe(z.url({ protocol: /^https?$/ }).optional()),
  anon_key: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => v || undefined)
    .pipe(
      z
        .string()
        .regex(/^[A-Za-z0-9._-]+$/, "The key may only contain letters, digits, dot, dash and underscore")
        .refine((k) => !isPrivilegedKey(k), "That is a secret or service-role key: enter the project's publishable (anon) key")
        .optional(),
    ),
});

export const FLASH_COOKIE = "harness_flash";

export interface AdminRequest {
  user: User;
  supabase: SupabaseClient;
  body: Record<string, unknown>;
  isForm: boolean;
}

function sameOrigin(request: Request): boolean {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const origin = request.headers.get("origin") ?? request.headers.get("referer");
  if (!host || !origin) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Admin-only entry for the harness routes: 404 for anyone else (admin URLs don't advertise
 * themselves). Accepts JSON, or a same-origin HTML form post (the panel works without client JS).
 */
export async function adminHarnessRequest(request: Request): Promise<AdminRequest | NextResponse> {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  if (!(await isAdmin(auth.supabase))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Cross-site requests are refused outright (defence in depth on top of SameSite cookies).
  if (request.headers.get("origin") && !sameOrigin(request)) return NextResponse.json({ error: "Cross-site requests are not accepted" }, { status: 403 });
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = await request.json().catch(() => null);
    return { user: auth.user, supabase: auth.supabase, body: body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}, isForm: false };
  }
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-site form posts are not accepted" }, { status: 403 });
    const form = await request.formData().catch(() => null);
    const body: Record<string, unknown> = {};
    form?.forEach((v, k) => {
      if (typeof v === "string") body[k] = v;
    });
    return { user: auth.user, supabase: auth.supabase, body, isForm: true };
  }
  return NextResponse.json({ error: "Send JSON or a form" }, { status: 415 });
}

function backTo(request: Request, submissionId: string): string {
  const fallback = "/admin/candidates";
  const ref = request.headers.get("referer");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let path = fallback;
  if (ref) {
    try {
      const u = new URL(ref);
      if (u.host === host && u.pathname.startsWith("/admin")) path = `${u.pathname}${u.search}`;
    } catch {
      // keep the fallback
    }
  }
  return `${path}#harness-${submissionId}`;
}

/** JSON for API callers; for form posts a 303 back to the admin page with a short-lived flash cookie. */
export function harnessResponse(request: Request, req: { isForm: boolean }, submissionId: string, outcome: { ok: boolean; message: string; status?: number; data?: unknown }): NextResponse {
  if (!req.isForm) return NextResponse.json(outcome.ok ? (outcome.data ?? { message: outcome.message }) : { error: outcome.message }, { status: outcome.status ?? (outcome.ok ? 200 : 400) });
  const res = new NextResponse(null, { status: 303, headers: { location: backTo(request, submissionId) } });
  const value = Buffer.from(JSON.stringify({ sid: submissionId, ok: outcome.ok, msg: outcome.message.slice(0, 1500), at: new Date().toISOString() })).toString("base64url");
  res.cookies.set(FLASH_COOKIE, value, { path: "/admin", maxAge: 120, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  return res;
}

export function readFlash(raw: string | undefined, submissionId: string): { ok: boolean; msg: string; at: string } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { sid?: string; ok?: boolean; msg?: string; at?: string };
    return v.sid === submissionId && typeof v.msg === "string" ? { ok: v.ok === true, msg: v.msg, at: String(v.at ?? "") } : null;
  } catch {
    return null;
  }
}

/** Turns a run summary into the one-line flash message. */
export function describeRun(label: string, s: HarnessRunSummary): string {
  const part = (name: string, keys: CheckKey[]) => (keys.length ? `${name}: ${keys.join(", ")}` : null);
  return [
    `${label} finished.`,
    part("passed", s.passed),
    part("failed", s.failed),
    part("inconclusive", s.inconclusive),
    part("inconclusive this time, earlier result kept", s.kept ?? []),
    part("skipped (month 2 already imported; earlier results stand)", s.skipped),
  ]
    .filter(Boolean)
    .join(" ");
}

export function errorOutcome(err: unknown): { ok: false; message: string; status: number } {
  if (err instanceof HarnessError) return { ok: false, message: err.message, status: err.status };
  console.error("harness:", err);
  return { ok: false, message: "The harness run failed unexpectedly. Check the server logs.", status: 500 };
}

export { type CheckKey };
