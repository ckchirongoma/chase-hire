/**
 * Records repo-check results (results.json from repo-checks.ts) as verification_runs rows.
 * This is the TRUSTED half of the repo checks: it never runs or reads candidate code, and it
 * treats results.json as hostile (strict schema: the seven R-keys, booleans/null, short strings).
 *
 *   npx tsx --env-file=.env.local scripts/verify-swe1/report.ts --in results.json \
 *     --submission-id <uuid> --repo-url https://github.com/<owner>/<repo> --sha <40-hex> \
 *     [--run-url <url>] [--harness-run-id <uuid>] [--untrusted-result success|failure|cancelled] [--dry-run]
 *
 * Needs SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SECRET_KEY (service role: CI
 * secrets or the admin's .env.local, never a NEXT_PUBLIC_ variable). GITHUB_TOKEN (optional)
 * re-asks GitHub for the CI status when the untrusted job could not (R6).
 *
 * The repo URL and SHA must match the submission's own (the commit frozen at submission), so a
 * run against another repo or commit can never be recorded as this candidate's result.
 */
import fs from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseArtifact, type Artifact } from "../../lib/harness/artifact";
import { pass, fail, inconclusive, toRunRow, type CheckResult } from "../../lib/harness/checks";
import { ciStatusForSha } from "../../lib/harness/github";
import { parseGithubRepo } from "../../lib/work/url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Args {
  input: string;
  submissionId: string;
  repoUrl: string;
  sha: string;
  runUrl: string | null;
  harnessRunId: string | null;
  untrustedResult: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const die = (m: string): never => {
    console.error(`report: ${m}`);
    process.exit(2);
  };
  const input = get("in") ?? die("--in is required");
  const submissionId = get("submission-id") ?? die("--submission-id is required");
  if (!UUID.test(submissionId)) die("--submission-id must be a UUID");
  const repoRaw = get("repo-url") ?? die("--repo-url is required");
  const repo = parseGithubRepo(repoRaw);
  const repoUrl = repo ? repo.url : repoRaw.startsWith("file://") || repoRaw.startsWith("/") ? repoRaw : die("--repo-url must be https://github.com/<owner>/<repo>");
  const sha = (get("sha") ?? die("--sha is required")).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) die("--sha must be a 40-character commit SHA");
  const harnessRunId = get("harness-run-id") || null;
  if (harnessRunId && !UUID.test(harnessRunId)) die("--harness-run-id must be a UUID");
  const runUrl = get("run-url") || null;
  if (runUrl && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(runUrl)) die("--run-url must be a GitHub Actions run URL");
  return { input, submissionId, repoUrl, sha, runUrl, harnessRunId, untrustedResult: get("untrusted-result") || null, dryRun: argv.includes("--dry-run") };
}

export class ReportError extends Error {}

/** Loads the submission and refuses unless repo + SHA are the ones frozen at submission. */
export async function verifySubmission(admin: SupabaseClient, args: Pick<Args, "submissionId" | "repoUrl" | "sha">): Promise<void> {
  const { data, error } = await admin.from("submissions").select("id, stage_key, repo_url, repo_commit_sha, snapshot").eq("id", args.submissionId).maybeSingle();
  if (error) throw new ReportError(`could not read the submission: ${error.message}`);
  if (!data) throw new ReportError("submission not found");
  if (data.stage_key !== "swe_test1") throw new ReportError("not a SWE Test 1 submission");
  const subRepo = data.repo_url ? (parseGithubRepo(String(data.repo_url))?.url ?? String(data.repo_url)) : null;
  const subSha = (data.repo_commit_sha as string | null) ?? ((data.snapshot as { repo?: { sha?: string } } | null)?.repo?.sha ?? null);
  if (!subRepo || subRepo.toLowerCase() !== args.repoUrl.toLowerCase()) throw new ReportError(`repo ${args.repoUrl} is not the submitted repo (${subRepo ?? "none"})`);
  if (!subSha || subSha.toLowerCase() !== args.sha) throw new ReportError(`commit ${args.sha.slice(0, 7)} is not the submitted commit (${subSha?.slice(0, 7) ?? "none recorded"})`);
}

/** Re-checks R6 with a token when the untrusted job (no token) could not get the CI status. */
export async function refreshR6(c: Artifact["checks"][number], repoUrl: string, sha: string, token: string | null): Promise<CheckResult | null> {
  if (c.key !== "R6" || c.passed !== null || !token) return null;
  const workflows = c.detail.evidence?.workflows;
  if (!Array.isArray(workflows) || !workflows.length) return null;
  const gh = parseGithubRepo(repoUrl);
  if (!gh) return null;
  const ci = await ciStatusForSha(gh.owner, gh.repo, sha, token);
  const evidence = { ...(c.detail.evidence ?? {}), ci_verdict: ci.verdict, runs: ci.latest.map((r) => `${r.name}: ${r.status}/${r.conclusion ?? "-"}`), refreshed_by: "report job" };
  if (ci.verdict === "green") return pass("R6", `CI is green on ${sha.slice(0, 7)} (${ci.latest.length} workflow${ci.latest.length === 1 ? "" : "s"})`, evidence);
  if (ci.verdict === "red") return fail("R6", `CI is not green on ${sha.slice(0, 7)}`, evidence);
  if (ci.verdict === "none") return fail("R6", `Workflows exist but none ran on ${sha.slice(0, 7)}`, evidence);
  return null;
}

async function finishRun(admin: SupabaseClient, args: Args, status: "done" | "failed", summary: Record<string, unknown>) {
  if (!args.harnessRunId || args.dryRun) return;
  await admin
    .from("harness_runs")
    .update({ status, finished_at: new Date().toISOString(), summary: { ...summary, run_url: args.runUrl } })
    .eq("id", args.harnessRunId)
    .eq("submission_id", args.submissionId)
    .eq("kind", "repo");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new ReportError("SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SECRET_KEY must be set");
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  await verifySubmission(admin, args);

  let ran_by: string | null = null;
  if (args.harnessRunId) {
    const { data } = await admin.from("harness_runs").select("id, ran_by").eq("id", args.harnessRunId).eq("submission_id", args.submissionId).eq("kind", "repo").maybeSingle();
    if (!data) throw new ReportError("--harness-run-id does not belong to this submission's repo checks");
    ran_by = (data.ran_by as string | null) ?? null;
  }

  let artifact: Artifact;
  try {
    if (!fs.existsSync(args.input)) throw new ReportError(`no results file (${args.untrustedResult ? `the repo-check job ended: ${args.untrustedResult}` : "the repo checks did not write one"})`);
    artifact = parseArtifact(fs.readFileSync(args.input, "utf8"));
    if (artifact.sha !== args.sha) throw new ReportError(`results.json is for commit ${artifact.sha.slice(0, 7)}, not ${args.sha.slice(0, 7)}`);
    if (artifact.repo_url.toLowerCase() !== args.repoUrl.toLowerCase()) throw new ReportError(`results.json is for ${artifact.repo_url}, not ${args.repoUrl}`);
  } catch (err) {
    await finishRun(admin, args, "failed", { error: (err as Error).message.slice(0, 500) });
    throw err;
  }

  const results: CheckResult[] = [];
  for (const c of artifact.checks) {
    const refreshed = await refreshR6(c, args.repoUrl, args.sha, process.env.GITHUB_TOKEN || null).catch(() => null);
    results.push(refreshed ?? { key: c.key, passed: c.passed, detail: { ...c.detail } });
  }
  // A key the untrusted job did not report is recorded as inconclusive, never as a pass.
  for (const k of ["R1", "R2", "R3", "R4", "R5", "R6", "R7"] as const) if (!results.some((r) => r.key === k)) results.push(inconclusive(k, "missing from the repo-check results"));

  const source = args.runUrl ? "github-actions" : "local";
  const rows = results.map((r) => toRunRow(args.submissionId, r, { ranBy: ran_by, meta: { source, run_url: args.runUrl, sha: args.sha, harness_run: args.harnessRunId, tools: artifact.tools ?? {} } }));
  for (const r of rows) console.log(`${r.check_key}  ${r.passed === true ? "PASS" : r.passed === false ? "FAIL" : "----"}  ${String(r.detail.summary).slice(0, 160)}`);
  if (args.dryRun) {
    console.log("\n--dry-run: nothing written");
    return;
  }
  const { error } = await admin.from("verification_runs").insert(rows);
  if (error) {
    await finishRun(admin, args, "failed", { error: `insert failed: ${error.message}` });
    throw new ReportError(`could not insert verification_runs: ${error.message}`);
  }
  await finishRun(admin, args, "done", {
    passed: results.filter((r) => r.passed === true).map((r) => r.key),
    failed: results.filter((r) => r.passed === false).map((r) => r.key),
    inconclusive: results.filter((r) => r.passed === null).map((r) => r.key),
  });
  console.log(`\nRecorded ${rows.length} repo checks for submission ${args.submissionId}`);
}

if (!process.env.VITEST) {
  main().catch((err) => {
    console.error(`report: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
