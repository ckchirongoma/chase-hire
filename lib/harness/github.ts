import { ciVerdict, type WorkflowRunLite } from "./repo-rules";

/**
 * GitHub API calls for the repo checks: the CI status of the graded commit (R6) and dispatching
 * the verify-swe1 workflow from the admin button. Only api.github.com (or GITHUB_API_URL in
 * tests) is called, never a candidate-supplied host, so plain fetch is fine here. No
 * "server-only" import: the repo-check CLI and the CI report job use this module too.
 */

export const githubApiBase = () => (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");

function headers(token?: string | null): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "chase-hire-verify-swe1",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export interface CiStatus {
  verdict: "green" | "red" | "pending" | "none" | "unknown";
  latest: { name: string; conclusion: string | null; status: string }[];
  error: string | null;
}

/** The latest workflow runs for a commit (GET /repos/{o}/{r}/actions/runs?head_sha=). */
export async function ciStatusForSha(owner: string, repo: string, sha: string, token?: string | null, timeoutMs = 15_000): Promise<CiStatus> {
  try {
    const res = await fetch(`${githubApiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=50`, {
      headers: headers(token),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const why = res.status === 404 ? "repository not found or private" : res.status === 403 || res.status === 429 ? "rate limited or access refused" : `HTTP ${res.status}`;
      return { verdict: "unknown", latest: [], error: `GitHub API: ${why}` };
    }
    const body = (await res.json()) as { workflow_runs?: Partial<WorkflowRunLite>[] };
    const runs = (body.workflow_runs ?? [])
      .filter((r) => typeof r.workflow_id === "number" && typeof r.created_at === "string")
      .map((r) => ({ name: String(r.name ?? "workflow"), workflow_id: r.workflow_id!, status: String(r.status ?? ""), conclusion: r.conclusion ?? null, created_at: r.created_at! }));
    const v = ciVerdict(runs);
    return { verdict: v.verdict, latest: v.latest, error: null };
  } catch (err) {
    return { verdict: "unknown", latest: [], error: `GitHub API: ${(err as Error)?.name === "TimeoutError" ? "timed out" : ((err as Error)?.message ?? String(err)).slice(0, 160)}` };
  }
}

export interface DispatchConfig {
  token: string;
  repo: string;
  ref: string;
  workflow: string;
}

/** Workflow dispatch is configured when GITHUB_ACTIONS_TOKEN and GITHUB_ACTIONS_REPO are set. */
export function dispatchConfig(): DispatchConfig | null {
  const token = process.env.GITHUB_ACTIONS_TOKEN;
  const repo = process.env.GITHUB_ACTIONS_REPO;
  if (!token || !repo || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) return null;
  return { token, repo, ref: process.env.GITHUB_ACTIONS_REF || "main", workflow: process.env.GITHUB_ACTIONS_WORKFLOW || "verify-swe1.yml" };
}

/** POST /repos/{repo}/actions/workflows/{workflow}/dispatches. Throws with GitHub's reason. */
export async function dispatchWorkflow(cfg: DispatchConfig, inputs: Record<string, string>): Promise<{ runUrl: string | null }> {
  const res = await fetch(`${githubApiBase()}/repos/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflow)}/dispatches`, {
    method: "POST",
    headers: { ...headers(cfg.token), "content-type": "application/json" },
    body: JSON.stringify({ ref: cfg.ref, inputs }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`GitHub refused the workflow dispatch (HTTP ${res.status})${text ? `: ${text}` : ""}`);
  }
  const body = res.status === 200 ? ((await res.json().catch(() => null)) as { html_url?: string; run_url?: string } | null) : null;
  return { runUrl: body?.html_url ?? null };
}

/** The command an admin runs locally when dispatch is not configured. */
export function localRepoCheckCommands(input: { submissionId: string; repoUrl: string; sha: string }): string[] {
  return [
    `npx tsx scripts/verify-swe1/repo-checks.ts --repo ${input.repoUrl} --sha ${input.sha} --out results.json --exec --db-reset`,
    `npx tsx --env-file=.env.local scripts/verify-swe1/report.ts --in results.json --submission-id ${input.submissionId} --repo-url ${input.repoUrl} --sha ${input.sha}`,
  ];
}
