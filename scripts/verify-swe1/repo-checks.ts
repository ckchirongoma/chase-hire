/**
 * SWE Test 1 repo checks R1–R7 (docs/07 "Repo checks", docs/16 check table) on the commit a
 * candidate submitted. Writes results.json (lib/harness/artifact.ts) for report.ts to record.
 *
 *   npx tsx scripts/verify-swe1/repo-checks.ts --repo https://github.com/<owner>/<repo> --sha <40-hex> \
 *     [--out results.json] [--exec] [--exec-mode docker|host] [--db-reset] [--workdir <dir>] [--keep] [--no-docker]
 *
 * Static checks (R1 history scan, R2, R3 static, R5 discovery, R6, R7) never run candidate code.
 * --exec runs the candidate's npm ci / lint / tsc / build / test for R4 and R5 — by default
 * inside a throwaway Docker container (node image, no capabilities, only the clone mounted) with
 * a minimal environment, so nothing from this shell (keys, tokens) reaches their code. Only use
 * --exec-mode host in a disposable sandbox. --db-reset starts a scratch Postgres for R3 with the
 * Supabase CLI (Docker needed) under its own project id and port, then removes it.
 *
 * In CI (.github/workflows/verify-swe1.yml) this runs in a job with no secrets; a separate job
 * validates results.json and writes verification_runs.
 *
 * gitleaks: the binary on PATH if present, else the zricethezav/gitleaks Docker image, else R1
 * falls back to looking for committed .env files in history (and is inconclusive if none). The
 * candidate's own .gitleaks.toml / .gitleaksignore are ignored so they cannot hide findings.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildArtifact } from "../../lib/harness/artifact";
import { fail, inconclusive, pass, type CheckResult, type Evidence } from "../../lib/harness/checks";
import { ciStatusForSha } from "../../lib/harness/github";
import {
  analyseMigrations,
  envFilesInHistory,
  findTests,
  parseEnvExample,
  parseGitleaksReport,
  rotationDocumented,
  scanClientSecrets,
  tail,
  type RepoFile,
} from "../../lib/harness/repo-rules";
import { parseGithubRepo } from "../../lib/work/url";

const GITLEAKS_IMAGE = process.env.GITLEAKS_IMAGE || "zricethezav/gitleaks:v8.24.2";
const NODE_IMAGE = process.env.VERIFY_NODE_IMAGE || "node:22-bookworm";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

// ───────────────────────── CLI ─────────────────────────

export interface Args {
  repo: string;
  sha: string;
  out: string;
  workdir: string | null;
  exec: boolean;
  execMode: "docker" | "host";
  dbReset: boolean;
  keep: boolean;
  /** Never use Docker (gitleaks image, sandboxed npm): for machines without it, and tests. */
  noDocker: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string) => argv.includes(`--${name}`);
  const repo = get("repo");
  const sha = get("sha")?.toLowerCase();
  if (!repo || !sha) usage("--repo and --sha are required");
  if (!/^[0-9a-f]{40}$/.test(sha!)) usage("--sha must be a full 40-character commit SHA");
  const local = repo!.startsWith("file://") || path.isAbsolute(repo!);
  if (!local && !parseGithubRepo(repo!)) usage("--repo must be https://github.com/<owner>/<repo> (or a local path, for tests)");
  const mode = get("exec-mode") ?? "docker";
  if (mode !== "docker" && mode !== "host") usage("--exec-mode must be docker or host");
  return {
    repo: local ? repo! : parseGithubRepo(repo!)!.url,
    sha: sha!,
    out: path.resolve(get("out") ?? "results.json"),
    workdir: get("workdir") ? path.resolve(get("workdir")!) : null,
    exec: has("exec"),
    execMode: mode as "docker" | "host",
    dbReset: has("db-reset"),
    keep: has("keep"),
    noDocker: has("no-docker"),
  };
}

function usage(msg: string): never {
  console.error(`repo-checks: ${msg}\n\nUsage: npx tsx scripts/verify-swe1/repo-checks.ts --repo <url> --sha <sha> [--out results.json] [--exec] [--exec-mode docker|host] [--db-reset] [--workdir dir] [--keep] [--no-docker]`);
  process.exit(2);
}

// ───────────────────────── Process helpers ─────────────────────────

interface Ran {
  code: number | null;
  out: string;
  timedOut: boolean;
  ms: number;
}

/** Runs a command with a timeout, capturing combined output (last 400 KB). Never throws. */
type Env = Record<string, string | undefined>;

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Env; timeoutMs: number; onTimeout?: () => void }): Promise<Ran> {
  const started = Date.now();
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: (opts.env ?? process.env) as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, out: String((err as Error).message), timedOut: false, ms: 0 });
      return;
    }
    const add = (b: Buffer) => {
      out += b.toString("utf8");
      if (out.length > 400_000) out = out.slice(-400_000);
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const timer = setTimeout(() => {
      timedOut = true;
      opts.onTimeout?.();
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, out: out + String(err.message), timedOut, ms: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut, ms: Date.now() - started });
    });
  });
}

let dockerDisabled = false;
const available = (cmd: string, args = ["--version"]) => !(cmd === "docker" && dockerDisabled) && spawnSync(cmd, args, { stdio: "ignore", timeout: 20_000 }).status === 0;

/** git with prompts disabled and no system/global config (so a hostile repo meets defaults). */
function git(args: string[], cwd?: string, timeoutMs = 300_000) {
  return run("git", args, {
    cwd,
    timeoutMs,
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ASKPASS: "/bin/false" },
  });
}

// ───────────────────────── Working tree ─────────────────────────

const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|sql|toml|ya?ml|md|txt|example|sample|template)$|(^|\/)(\.env[\w.-]*|\.gitignore|Dockerfile)$/;

/** Text files of the checked-out tree (symlinks and big/binary files skipped). */
function readTree(root: string): RepoFile[] {
  const out: RepoFile[] = [];
  let total = 0;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (/^(\.git|node_modules|\.next|dist|build|out|coverage)$/.test(e.name)) continue;
        walk(abs);
      } else if (e.isFile() && TEXT_FILE.test(rel)) {
        const size = fs.statSync(abs).size;
        if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) continue;
        total += size;
        out.push({ path: rel, content: fs.readFileSync(abs, "utf8") });
      }
    }
  };
  walk(root);
  return out;
}

const fileText = (files: RepoFile[], p: string) => files.find((f) => f.path === p)?.content ?? null;
const readme = (files: RepoFile[]) => files.find((f) => /^readme(\.md|\.markdown|\.txt)?$/i.test(f.path))?.content ?? null;

// ───────────────────────── R1 ─────────────────────────

const GITLEAKS_CONFIG = `title = "verify-swe1"
[extend]
useDefault = true

[[rules]]
id = "supabase-secret-key"
description = "Supabase secret API key"
regex = '''\\bsb_secret_[A-Za-z0-9_-]{20,}'''

[[rules]]
id = "env-file-secret"
description = "Secret-looking value assigned in a committed .env file"
path = '''(^|/)\\.env(\\.[A-Za-z0-9_-]+)*$'''
regex = '''(?i)[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASS)[A-Z0-9_]*\\s*=\\s*["']?([A-Za-z0-9_\\-.+/=]{20,})'''
secretGroup = 1
entropy = 3.0
`;

async function r1(clone: string, sha: string, files: RepoFile[], tmp: string): Promise<{ result: CheckResult; tool: string }> {
  const log = await git(["log", sha, "--diff-filter=A", "--name-only", "--pretty=format:"], clone);
  const envFiles = envFilesInHistory(log.out);
  const rotation = rotationDocumented(readme(files));
  const cfgDir = path.join(tmp, "gitleaks");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "gitleaks.toml"), GITLEAKS_CONFIG);
  const report = path.join(cfgDir, "report.json");

  // The candidate's own gitleaks config/ignore files must not suppress findings.
  const hidden: string[] = [];
  for (const f of [".gitleaksignore", ".gitleaks.toml"]) {
    const p = path.join(clone, f);
    if (fs.existsSync(p)) {
      fs.renameSync(p, `${p}.verify-swe1-hidden`);
      hidden.push(f);
    }
  }
  const common = ["--report-format", "json", "--redact", "--exit-code", "0", "--no-banner", "--ignore-gitleaks-allow", "--log-level", "error", `--log-opts=${sha}`];
  let tool = "none";
  let ran: Ran | null = null;
  try {
    if (available("gitleaks", ["version"])) {
      tool = "gitleaks (binary)";
      ran = await run("gitleaks", ["git", clone, "--config", path.join(cfgDir, "gitleaks.toml"), "--gitleaks-ignore-path", cfgDir, "--report-path", report, ...common], { timeoutMs: 600_000 });
    } else if (available("docker", ["info"])) {
      tool = `gitleaks (${GITLEAKS_IMAGE})`;
      ran = await run(
        "docker",
        [
          "run", "--rm", "--network", "none",
          "-e", "GIT_CONFIG_COUNT=1", "-e", "GIT_CONFIG_KEY_0=safe.directory", "-e", "GIT_CONFIG_VALUE_0=*",
          "-v", `${clone}:/repo:ro`, "-v", `${cfgDir}:/cfg`,
          GITLEAKS_IMAGE, "git", "/repo", "--config", "/cfg/gitleaks.toml", "--gitleaks-ignore-path", "/cfg", "--report-path", "/cfg/report.json", ...common,
        ],
        { timeoutMs: 900_000 },
      );
    }
  } finally {
    for (const f of hidden) fs.renameSync(path.join(clone, `${f}.verify-swe1-hidden`), path.join(clone, f));
  }

  const evidence: Evidence = { tool, env_files_in_history: envFiles, rotation_documented: rotation.documented, rotation_quote: rotation.quote, candidate_gitleaks_files_ignored: hidden };
  if (ran && ran.code === 0 && fs.existsSync(report)) {
    const findings = parseGitleaksReport(JSON.parse(fs.readFileSync(report, "utf8") || "[]"));
    const unique = [...new Map(findings.map((f) => [`${f.rule}|${f.file}|${f.commit}`, f])).values()];
    evidence.findings = unique.length;
    evidence.examples = unique.slice(0, 15).map((f) => `${f.rule} in ${f.file} @ ${f.commit}`);
    if (!unique.length) return { result: pass("R1", "gitleaks finds no secret anywhere in the history of the submitted commit", evidence), tool };
    if (rotation.documented) {
      return {
        result: pass("R1", `gitleaks finds ${unique.length} secret${unique.length === 1 ? "" : "s"} in history, and the README documents the key rotation`, evidence, "the secret is still in history: rotated but not rewritten (ideal is both)"),
        tool,
      };
    }
    return { result: fail("R1", `gitleaks finds ${unique.length} secret${unique.length === 1 ? "" : "s"} in history and the README does not document a key rotation`, evidence), tool };
  }
  if (ran) evidence.gitleaks_output = tail(ran.out, 15);

  // No gitleaks: committed .env files with secret-looking values still decide a fail.
  if (envFiles.length) {
    const p = await git(["log", sha, "-p", "--", ...envFiles], clone);
    const secrets = p.out.split("\n").filter((l) => /^\+[^+]/.test(l) && /(KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*["']?[A-Za-z0-9_\-.+/=]{20,}/i.test(l)).length;
    evidence.secret_lines_in_env_history = secrets;
    if (secrets && !rotation.documented) return { result: fail("R1", `${envFiles.join(", ")} with ${secrets} secret-looking value${secrets === 1 ? "" : "s"} is in history and the README does not document a key rotation`, evidence), tool };
    if (secrets) return { result: pass("R1", `${envFiles.join(", ")} with secrets is in history, but the README documents the rotation`, evidence, "gitleaks did not run: confirm the full-history scan by hand"), tool };
  }
  return { result: inconclusive("R1", ran ? `gitleaks failed (exit ${ran.code}${ran.timedOut ? ", timed out" : ""})` : "gitleaks is not available (no binary, no Docker)", evidence), tool };
}

// ───────────────────────── R2, R3, R5 (static), R6, R7 ─────────────────────────

function r2(files: RepoFile[]): CheckResult {
  const matches = scanClientSecrets(files);
  const evidence: Evidence = { files_scanned: files.length, matches: matches.slice(0, 20).map((m) => `${m.file}:${m.line} [${m.rule}] ${m.text}`) };
  if (matches.length) return fail("R2", `${matches.length} service-role/secret reference${matches.length === 1 ? "" : "s"} in NEXT_PUBLIC_* names or 'use client' files`, evidence);
  return pass("R2", "No service_role / SERVICE / sb_secret_ in NEXT_PUBLIC_* names or 'use client' files", evidence);
}

function r3Static(clone: string, files: RepoFile[]) {
  const dirExists = fs.existsSync(path.join(clone, "supabase", "migrations"));
  return { dirExists, ...analyseMigrations(files) };
}

async function r3Dynamic(clone: string, tmp: string): Promise<Evidence & { ok: boolean | null; reason?: string }> {
  if (!available("supabase", ["--version"]) && !available("npx", ["--version"])) return { ok: null, reason: "Supabase CLI not available" };
  if (!available("docker", ["info"])) return { ok: null, reason: "Docker not available" };
  const cli = available("supabase", ["--version"]) ? ["supabase"] : ["npx", "--yes", "supabase"];
  const projectId = `verify-swe1-${randomBytes(4).toString("hex")}`;
  const port = 56000 + Math.floor(Math.random() * 3000);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME ?? tmp, DOCKER_HOST: process.env.DOCKER_HOST, SUPABASE_TELEMETRY_DISABLED: "1" } as Env;
  const sb = (args: string[], timeoutMs: number) => run(cli[0], [...cli.slice(1), ...args, "--workdir", clone], { env, timeoutMs });
  const cfg = path.join(clone, "supabase", "config.toml");
  if (!fs.existsSync(cfg)) {
    const init = await sb(["init", "--force"], 120_000);
    if (init.code !== 0) return { ok: null, reason: "supabase init failed", output: tail(init.out, 10) };
  }
  // Our own project id and port: never touches another local stack (e.g. the platform's).
  let toml = fs.readFileSync(cfg, "utf8");
  toml = /^\s*project_id\s*=.*$/m.test(toml) ? toml.replace(/^\s*project_id\s*=.*$/m, `project_id = "${projectId}"`) : `project_id = "${projectId}"\n${toml}`;
  if (/^\[db\][^[]*?^\s*port\s*=.*$/ms.test(toml)) toml = toml.replace(/(^\[db\][^[]*?^\s*)port\s*=.*$/ms, `$1port = ${port}`);
  else if (/^\[db\]\s*$/m.test(toml)) toml = toml.replace(/^\[db\]\s*$/m, `[db]\nport = ${port}`);
  else toml += `\n[db]\nport = ${port}\n`;
  toml = toml.replace(/^(\s*shadow_port\s*=).*$/m, `$1 ${port + 1}`);
  fs.writeFileSync(cfg, toml);
  const migrationFiles = fs.existsSync(path.join(clone, "supabase", "migrations")) ? fs.readdirSync(path.join(clone, "supabase", "migrations")).filter((f) => f.endsWith(".sql")).length : 0;
  const query = async (sql: string): Promise<string | null> => {
    const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    const viaPsql = available("psql", ["--version"]) ? await run("psql", [url, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { timeoutMs: 60_000, env: { PATH: process.env.PATH } }) : null;
    if (viaPsql?.code === 0) return viaPsql.out;
    const viaDocker = await run("docker", ["exec", `supabase_db_${projectId}`, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { timeoutMs: 60_000 });
    return viaDocker.code === 0 ? viaDocker.out : null;
  };
  try {
    const start = await sb(["db", "start"], 900_000);
    if (start.code !== 0) {
      // Our infrastructure (ports, image pulls, Docker) failing is not the candidate's fault.
      if (/already allocated|address already in use|pull access denied|toomanyrequests|Cannot connect to the Docker daemon|no space left/i.test(start.out)) {
        return { ok: null, reason: "the scratch database could not start (infrastructure)", output: tail(start.out, 15) };
      }
      return { ok: false, reason: "the database did not start with these migrations (they do not apply cleanly)", output: tail(start.out, 25) };
    }
    let applied = Number((await query("select count(*) from supabase_migrations.schema_migrations"))?.trim() ?? "0") || 0;
    if (applied < migrationFiles) {
      const up = await sb(["migration", "up", "--local", "--include-all"], 600_000);
      if (up.code !== 0) return { ok: false, reason: "supabase migration up failed", output: tail(up.out, 25), applied, migration_files: migrationFiles };
      applied = Number((await query("select count(*) from supabase_migrations.schema_migrations"))?.trim() ?? "0") || 0;
    }
    const noRls = await query("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity order by 1");
    const tables = await query("select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p')");
    if (noRls === null || tables === null) return { ok: null, reason: "could not query the scratch database", applied, migration_files: migrationFiles };
    const missing = noRls.split("\n").map((s) => s.trim()).filter(Boolean);
    return { ok: missing.length === 0, applied, migration_files: migrationFiles, public_tables: Number(tables.trim()), tables_without_rls: missing, ...(missing.length ? { reason: `tables without RLS after reset: ${missing.join(", ")}` } : {}) };
  } finally {
    await sb(["stop", "--no-backup"], 180_000);
  }
}

function r6Static(clone: string): string[] {
  const dir = path.join(clone, ".github", "workflows");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
}

async function r6(clone: string, repo: string, sha: string): Promise<CheckResult> {
  const workflows = r6Static(clone);
  const evidence: Evidence = { workflows };
  if (!workflows.length) return fail("R6", "No .github/workflows/*.yml in the repo", evidence);
  const gh = parseGithubRepo(repo);
  if (!gh) return inconclusive("R6", "not a GitHub repo: CI status unknown", evidence);
  const ci = await ciStatusForSha(gh.owner, gh.repo, sha, process.env.GITHUB_TOKEN || null);
  evidence.ci_verdict = ci.verdict;
  evidence.runs = ci.latest.map((r) => `${r.name}: ${r.status}/${r.conclusion ?? "-"}`);
  if (ci.error) evidence.ci_error = ci.error;
  if (ci.verdict === "green") return pass("R6", `CI is green on ${sha.slice(0, 7)} (${ci.latest.length} workflow${ci.latest.length === 1 ? "" : "s"})`, evidence);
  if (ci.verdict === "red") return fail("R6", `CI is not green on ${sha.slice(0, 7)}: ${evidence.runs.join("; ")}`, evidence);
  if (ci.verdict === "none") return fail("R6", `Workflows exist but none ran on ${sha.slice(0, 7)}`, evidence);
  if (ci.verdict === "pending") return inconclusive("R6", "CI is still running on this commit", evidence);
  return inconclusive("R6", `workflows exist; CI status unknown (${ci.error ?? "GitHub API unavailable"})`, evidence);
}

async function r7(clone: string): Promise<CheckResult> {
  const probes = [".env", ".env.local", ".env.production"];
  const ignored: Record<string, boolean> = {};
  for (const p of probes) ignored[p] = (await git(["check-ignore", "-q", "--no-index", p], clone)).code === 0;
  const tracked = (await git(["ls-files"], clone)).out.split("\n").filter((f) => /(^|\/)\.env(\.[\w-]+)*$/.test(f) && !/\.(example|sample|template)$/.test(f));
  const example = fs.existsSync(path.join(clone, ".env.example"));
  const evidence: Evidence = { gitignored: ignored, env_example: example, tracked_env_files: tracked };
  const allIgnored = probes.every((p) => ignored[p]);
  if (allIgnored && example && !tracked.length) return pass("R7", ".env* is gitignored and .env.example exists", evidence);
  const why = [!allIgnored ? `not gitignored: ${probes.filter((p) => !ignored[p]).join(", ")}` : null, !example ? "no .env.example" : null, tracked.length ? `committed: ${tracked.join(", ")}` : null].filter(Boolean);
  return fail("R7", why.join("; "), evidence);
}

// ───────────────────────── R4 / R5 (execute) ─────────────────────────

interface Step {
  name: string;
  cmd: string;
  timeoutMs: number;
}

async function execSteps(clone: string, mode: "docker" | "host", steps: Step[], env: Record<string, string>): Promise<{ name: string; code: number | null; timedOut: boolean; ms: number; tail: string[] }[]> {
  const results: { name: string; code: number | null; timedOut: boolean; ms: number; tail: string[] }[] = [];
  const baseEnv: Record<string, string> = { ...env, CI: "true", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: "--max-old-space-size=4096", npm_config_audit: "false", npm_config_fund: "false" };
  for (const step of steps) {
    let ran: Ran;
    if (mode === "docker") {
      const name = `verify-swe1-${randomBytes(4).toString("hex")}`;
      const uid = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid?.() ?? 0}` : "1000:1000";
      const envArgs = Object.entries({ ...baseEnv, HOME: "/tmp/home", npm_config_cache: "/tmp/npm-cache" }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      ran = await run(
        "docker",
        ["run", "--rm", "--name", name, "--memory", "6g", "--cpus", "2", "--pids-limit", "4096", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--user", uid, "-v", `${clone}:/work`, "-w", "/work", ...envArgs, NODE_IMAGE, "sh", "-c", `mkdir -p /tmp/home && ${step.cmd}`],
        { timeoutMs: step.timeoutMs, onTimeout: () => spawnSync("docker", ["kill", name], { stdio: "ignore" }) },
      );
    } else {
      ran = await run("sh", ["-c", step.cmd], { cwd: clone, timeoutMs: step.timeoutMs, env: { PATH: process.env.PATH, HOME: path.join(os.tmpdir(), "verify-swe1-home"), ...baseEnv } });
    }
    results.push({ name: step.name, code: ran.code, timedOut: ran.timedOut, ms: ran.ms, tail: tail(ran.out, 30) });
    if (ran.code !== 0) break;
  }
  return results;
}

async function r4r5(clone: string, files: RepoFile[], args: Args): Promise<CheckResult[]> {
  const pkgText = fileText(files, "package.json");
  const tests = findTests(files);
  const testEvidence: Evidence = { test_files: tests.testFiles.length, import_tests: tests.importTests.slice(0, 10), rd07_tests: tests.rd07Tests.slice(0, 10) };
  if (!pkgText) return [fail("R4", "No package.json at the repo root"), fail("R5", "No package.json at the repo root", testEvidence)];
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return [fail("R4", "package.json is not valid JSON"), fail("R5", "package.json is not valid JSON", testEvidence)];
  }
  const hasTest = typeof pkg.scripts?.test === "string" && !/no test specified/.test(pkg.scripts.test);
  if (!args.exec) {
    return [
      inconclusive("R4", "not run: the candidate's npm scripts run only with --exec (in CI or a sandbox)", { scripts: Object.keys(pkg.scripts ?? {}) }),
      hasTest ? inconclusive("R5", "tests not run (no --exec); see the discovery evidence", testEvidence) : fail("R5", "No npm test script", testEvidence),
    ];
  }
  if (args.execMode === "docker" && !available("docker", ["info"])) {
    const why = "Docker is not available to run the candidate's code safely (use --exec-mode host only in a disposable sandbox)";
    return [inconclusive("R4", why), inconclusive("R5", why, testEvidence)];
  }
  const env = parseEnvExample(fileText(files, ".env.example"));
  const build = await execSteps(clone, args.execMode, [
    { name: "npm ci", cmd: "npm ci", timeoutMs: 600_000 },
    { name: "npm run lint", cmd: "npm run lint", timeoutMs: 300_000 },
    // The project's own TypeScript only: "npx tsc" would fetch an unrelated "tsc" package.
    { name: "tsc --noEmit", cmd: 'if [ -x node_modules/.bin/tsc ]; then node_modules/.bin/tsc --noEmit; else echo "typescript is not installed (no node_modules/.bin/tsc)"; exit 1; fi', timeoutMs: 300_000 },
    { name: "npm run build", cmd: "npm run build", timeoutMs: 900_000 },
  ], env);
  const r4Evidence: Evidence = { steps: build.map((s) => ({ step: s.name, exit: s.code, timed_out: s.timedOut, seconds: Math.round(s.ms / 1000) })), env_from_example: Object.keys(env) };
  const failed = build.find((s) => s.code !== 0);
  const results: CheckResult[] = [];
  if (failed) {
    r4Evidence.output = failed.tail;
    results.push(fail("R4", `${failed.name} ${failed.timedOut ? "timed out" : `exited ${failed.code}`}`, r4Evidence));
  } else results.push(pass("R4", "npm ci, lint, tsc --noEmit and build all exit 0", r4Evidence));

  if (!hasTest) results.push(fail("R5", "No npm test script", testEvidence));
  else if (build[0]?.code !== 0) results.push(inconclusive("R5", "dependencies did not install (see R4), so the tests could not run", testEvidence));
  else {
    const t = (await execSteps(clone, args.execMode, [{ name: "npm test", cmd: "npm test", timeoutMs: 600_000 }], env))[0];
    const ev: Evidence = { ...testEvidence, exit: t.code, timed_out: t.timedOut, seconds: Math.round(t.ms / 1000), output: t.tail.slice(-15) };
    if (t.code !== 0) results.push(fail("R5", `npm test ${t.timedOut ? "timed out" : `exited ${t.code}`}`, ev));
    else if (!tests.importTests.length || !tests.rd07Tests.length)
      results.push(fail("R5", `Tests pass, but none covers ${[!tests.importTests.length ? "the import" : null, !tests.rd07Tests.length ? "RD-07 (callback date)" : null].filter(Boolean).join(" or ")}`, ev));
    else results.push(pass("R5", `npm test passes; ${tests.importTests.length} test file(s) cover the import and ${tests.rd07Tests.length} cover RD-07`, ev));
  }
  return results;
}

// ───────────────────────── Main ─────────────────────────

export async function repoChecks(args: Args): Promise<{ checks: CheckResult[]; tools: Record<string, string> }> {
  dockerDisabled = args.noDocker;
  const tmp = args.workdir ?? fs.mkdtempSync(path.join(os.tmpdir(), "verify-swe1-"));
  fs.mkdirSync(tmp, { recursive: true });
  const clone = path.join(tmp, "repo");
  const tools: Record<string, string> = { node: process.version };
  const all = (reason: string) => (["R1", "R2", "R3", "R4", "R5", "R6", "R7"] as const).map((k) => inconclusive(k, reason));
  try {
    const cl = await git(["clone", "--quiet", "--no-checkout", "--", args.repo, clone], undefined, 600_000);
    if (cl.code !== 0) return { checks: all(`could not clone the repository (${tail(cl.out, 3).join(" ").slice(0, 200)})`), tools };
    let co = await git(["checkout", "--quiet", "--detach", args.sha], clone);
    if (co.code !== 0) {
      await git(["fetch", "--quiet", "origin", args.sha], clone);
      co = await git(["checkout", "--quiet", "--detach", args.sha], clone);
      if (co.code !== 0) return { checks: all(`commit ${args.sha.slice(0, 7)} is not in the repository (force-pushed away?)`), tools };
    }
    const files = readTree(clone);
    const checks: CheckResult[] = [];

    const leaks = await r1(clone, args.sha, files, tmp);
    tools.gitleaks = leaks.tool;
    checks.push(leaks.result);
    checks.push(r2(files));

    const st = r3Static(clone, files);
    const r3Evidence: Evidence = { migrations_dir: st.dirExists, migration_files: st.files.length, tables: st.tables, without_rls: st.withoutRls, disabled_later: st.disabledLater };
    let r3: CheckResult;
    if (!st.dirExists || !st.files.length) r3 = fail("R3", "No supabase/migrations/*.sql: the schema is not reproducible", r3Evidence);
    else if (!st.tables.length) r3 = fail("R3", "The migrations create no public tables", r3Evidence);
    else if (st.withoutRls.length) r3 = fail("R3", `Tables without RLS in the migrations: ${st.withoutRls.join(", ")}`, r3Evidence);
    else r3 = pass("R3", `${st.files.length} migrations; all ${st.tables.length} public tables enable RLS (static)`, r3Evidence, args.dbReset ? undefined : "static check only: the full db reset runs in CI (--db-reset)");
    if (args.dbReset && r3.passed !== false) {
      const dyn = await r3Dynamic(clone, tmp);
      const { ok, reason, ...rest } = dyn;
      r3Evidence.db_reset = rest as Evidence;
      if (ok === true) r3 = pass("R3", `${st.files.length} migrations apply cleanly on a scratch database and every public table has RLS`, r3Evidence);
      else if (ok === false) r3 = fail("R3", `db reset: ${reason}`, r3Evidence);
      else r3 = { ...r3, detail: { ...r3.detail, evidence: r3Evidence, reviewer_note: `static check passed; the db reset could not run (${reason})` } };
    }
    checks.push(r3);

    checks.push(...(await r4r5(clone, files, args)));
    checks.push(await r6(clone, args.repo, args.sha));
    checks.push(await r7(clone));
    const order = ["R1", "R2", "R3", "R4", "R5", "R6", "R7"];
    return { checks: checks.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)), tools };
  } finally {
    if (!args.keep) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const { checks, tools } = await repoChecks(args);
  const artifact = buildArtifact({ repoUrl: args.repo, sha: args.sha, checks, tools });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(artifact, null, 2));
  for (const c of artifact.checks) console.log(`${c.key}  ${c.passed === true ? "PASS" : c.passed === false ? "FAIL" : "----"}  ${c.detail.summary}`);
  console.log(`\nWrote ${args.out} in ${Math.round((Date.now() - started) / 1000)} s`);
}

// Imported by tests (VITEST is set): no CLI run.
if (!process.env.VITEST) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
