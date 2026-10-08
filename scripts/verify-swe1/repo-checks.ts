/**
 * SWE Test 1 repo checks R1–R7 (docs/07 "Repo checks", docs/16 check table) on the commit a
 * candidate submitted. Writes results.json (lib/harness/artifact.ts) for report.ts to record.
 *
 *   npx tsx scripts/verify-swe1/repo-checks.ts --repo https://github.com/<owner>/<repo> --sha <40-hex> \
 *     [--out results.json] [--workdir <dir>] [--keep] [--no-docker] \
 *     [--disposable-sandbox [--exec] [--exec-mode docker|host] [--db-reset]]
 *
 * Two phases, so the candidate's code can never change what the other checks see:
 *
 * 1. Static (never runs candidate code): clone, check out the SHA, then everything that reads the
 *    tree or runs git: R1 (gitleaks over the history and over the checked-out tree), R2, R3 (static
 *    replay of the migrations; with --db-reset, a scratch Postgres built from a private copy of the
 *    migration files only), R6 (workflow files + CI status), R7, and test discovery for R5. Every
 *    git call runs with core.fsmonitor and hooks off, and no system/global config.
 *
 * 2. Candidate code (--exec): npm ci / lint / tsc / build / test (R4, R5) run on an EXPORT of the
 *    commit (git checkout-index: no .git), never on the clone, so nothing the code writes can reach
 *    git or the files phase 1 judged. By default each step runs in a throwaway Docker container
 *    (no capabilities, only the export mounted); npm ci needs the registry, every later step runs
 *    with --network none.
 *
 * --exec and --db-reset run the candidate's code (npm lifecycle scripts; SQL as a database
 * superuser, which can reach anything the Docker network can). They are refused unless
 * --disposable-sandbox is given: run them in CI (.github/workflows/verify-swe1.yml, whose
 * untrusted job has no secrets) or a throwaway VM, never on a workstation with credentials or a
 * local Supabase. Without them the static checks run, and R4/R5 are inconclusive.
 *
 * gitleaks: the binary on PATH if present, else the zricethezav/gitleaks Docker image, else R1
 * falls back to looking for committed .env files in history. The candidate's own .gitleaks.toml /
 * .gitleaksignore are ignored so they cannot hide findings.
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
  CLI_MIGRATION_NAME,
  envFilesInHistory,
  findTests,
  parseEnvExample,
  parseGitleaksReport,
  r1Verdict,
  rotationDocumented,
  scanClientSecrets,
  tail,
  type GitleaksFinding,
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
  /** The caller confirms this machine is disposable (CI's untrusted job, a throwaway VM). Required by --exec and --db-reset. */
  disposableSandbox: boolean;
}

const SANDBOX_REFUSAL =
  "--exec and --db-reset run the candidate's code (npm lifecycle scripts; SQL as a database superuser that can reach your Docker network). Run them in CI (.github/workflows/verify-swe1.yml) or in a throwaway VM with --disposable-sandbox, never on a workstation with credentials or a local Supabase. Without them, the static checks run.";

export function parseArgs(argv: string[]): Args {
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
  const args: Args = {
    repo: local ? repo! : parseGithubRepo(repo!)!.url,
    sha: sha!,
    out: path.resolve(get("out") ?? "results.json"),
    workdir: get("workdir") ? path.resolve(get("workdir")!) : null,
    exec: has("exec"),
    execMode: mode as "docker" | "host",
    dbReset: has("db-reset"),
    keep: has("keep"),
    noDocker: has("no-docker"),
    disposableSandbox: has("disposable-sandbox"),
  };
  if ((args.exec || args.dbReset) && !args.disposableSandbox) usage(SANDBOX_REFUSAL);
  return args;
}

function usage(msg: string): never {
  console.error(
    `repo-checks: ${msg}\n\nUsage: npx tsx scripts/verify-swe1/repo-checks.ts --repo <url> --sha <sha> [--out results.json] [--workdir dir] [--keep] [--no-docker] [--disposable-sandbox [--exec] [--exec-mode docker|host] [--db-reset]]`,
  );
  process.exit(2);
}

// ───────────────────────── Process helpers ─────────────────────────

interface Ran {
  code: number | null;
  out: string;
  timedOut: boolean;
  ms: number;
}

type Env = Record<string, string | undefined>;

/** Runs a command with a timeout, capturing combined output (last 400 KB). Never throws. */
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

/**
 * Environment for git and for tools that run git (gitleaks): no system/global config, no prompts,
 * and (a second layer: the clone's own .git/config is ours and never touched by candidate code)
 * no fsmonitor command and no hooks.
 */
const GIT_ENV: Env = {
  HOME: os.tmpdir(),
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ASKPASS: "/bin/false",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "core.hooksPath",
  GIT_CONFIG_VALUE_1: "/dev/null",
};
const SAFE_GIT_FLAGS = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never"];

function git(args: string[], cwd?: string, timeoutMs = 300_000) {
  return run("git", [...SAFE_GIT_FLAGS, ...args], { cwd, timeoutMs, env: { PATH: process.env.PATH, ...GIT_ENV } });
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
        const size = fs.lstatSync(abs).size;
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

/** Renames the candidate's gitleaks config/ignore files in `dir` while `fn` runs, so they cannot suppress findings. */
async function withoutGitleaksFiles<T>(dir: string, fn: (hidden: string[]) => Promise<T>): Promise<T> {
  const hidden: string[] = [];
  for (const f of [".gitleaksignore", ".gitleaks.toml"]) {
    const p = path.join(dir, f);
    if (fs.lstatSync(p, { throwIfNoEntry: false })) {
      fs.renameSync(p, `${p}.verify-swe1-hidden`);
      hidden.push(f);
    }
  }
  try {
    return await fn(hidden);
  } finally {
    for (const f of hidden) fs.renameSync(path.join(dir, `${f}.verify-swe1-hidden`), path.join(dir, f));
  }
}

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
# [ \\t]* (not \\s*): an empty "KEY=" must not swallow the next line as its value.
regex = '''(?im)^[ \\t]*(?:export[ \\t]+)?[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASS)[A-Z0-9_]*[ \\t]*=[ \\t]*["']?([A-Za-z0-9_\\-.+/=]{20,})'''
secretGroup = 1
entropy = 3.0
[[rules.allowlists]]
description = "Example env files hold placeholders, not secrets"
paths = ['''(^|/)\\.env(\\.[A-Za-z0-9_-]+)*\\.(example|sample|template|dist)$''']
`;

const ENV_SECRET_LINE = /(KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*["']?[A-Za-z0-9_\-.+/=]{20,}/i;

/**
 * Runs gitleaks over the history of `sha` in the clone ("git") or over a checked-out tree ("dir").
 * Returns the findings with file paths relative to the scanned root, or null when it could not run.
 */
async function gitleaks(mode: "git" | "dir", target: string, cfgDir: string, sha: string): Promise<{ tool: string; findings: GitleaksFinding[] | null; problem: string | null }> {
  const report = `report-${mode}.json`;
  const common = ["--report-format", "json", "--redact", "--exit-code", "0", "--no-banner", "--ignore-gitleaks-allow", "--log-level", "error", ...(mode === "git" ? [`--log-opts=${sha}`] : [])];
  let tool = "none";
  let ran: Ran | null = null;
  let root = target;
  if (available("gitleaks", ["version"])) {
    tool = "gitleaks (binary)";
    ran = await run("gitleaks", [mode, target, "--config", path.join(cfgDir, "gitleaks.toml"), "--gitleaks-ignore-path", cfgDir, "--report-path", path.join(cfgDir, report), ...common], {
      timeoutMs: 600_000,
      env: { PATH: process.env.PATH, ...GIT_ENV },
    });
  } else if (available("docker", ["info"])) {
    tool = `gitleaks (${GITLEAKS_IMAGE})`;
    root = "/src";
    ran = await run(
      "docker",
      [
        "run", "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "-e", "GIT_CONFIG_COUNT=3", "-e", "GIT_CONFIG_KEY_0=safe.directory", "-e", "GIT_CONFIG_VALUE_0=*",
        "-e", "GIT_CONFIG_KEY_1=core.fsmonitor", "-e", "GIT_CONFIG_VALUE_1=false", "-e", "GIT_CONFIG_KEY_2=core.hooksPath", "-e", "GIT_CONFIG_VALUE_2=/dev/null",
        "-v", `${target}:/src:ro`, "-v", `${cfgDir}:/cfg`,
        GITLEAKS_IMAGE, mode, "/src", "--config", "/cfg/gitleaks.toml", "--gitleaks-ignore-path", "/cfg", "--report-path", `/cfg/${report}`, ...common,
      ],
      { timeoutMs: 900_000 },
    );
  }
  if (!ran) return { tool, findings: null, problem: "gitleaks is not available (no binary, no Docker)" };
  const file = path.join(cfgDir, report);
  if (ran.code !== 0 || !fs.existsSync(file)) return { tool, findings: null, problem: `gitleaks ${mode} failed (exit ${ran.code}${ran.timedOut ? ", timed out" : ""}): ${tail(ran.out, 3).join(" ").slice(0, 200)}` };
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8") || "[]");
  } catch {
    return { tool, findings: null, problem: `gitleaks ${mode} wrote an unreadable report` };
  }
  const prefix = `${root.replace(/\/+$/, "")}/`;
  const findings = parseGitleaksReport(json).map((f) => ({ ...f, file: f.file.startsWith(prefix) ? f.file.slice(prefix.length) : f.file.replace(/^\.\//, "") }));
  return { tool, findings, problem: null };
}

async function r1(clone: string, exported: string, sha: string, files: RepoFile[], tmp: string): Promise<{ result: CheckResult; tool: string }> {
  const log = await git(["log", sha, "--diff-filter=A", "--name-only", "--pretty=format:"], clone);
  const envFiles = envFilesInHistory(log.out);
  const rotation = rotationDocumented(readme(files));
  const cfgDir = path.join(tmp, "gitleaks");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "gitleaks.toml"), GITLEAKS_CONFIG);

  const evidence: Evidence = { env_files_in_history: envFiles };
  const history = await withoutGitleaksFiles(clone, async (hidden) => {
    evidence.candidate_gitleaks_files_ignored = hidden;
    return gitleaks("git", clone, cfgDir, sha);
  });
  evidence.tool = history.tool;

  if (history.findings) {
    // Which secrets are still in the graded commit: gitleaks over the exported tree (no .git).
    const tree = await withoutGitleaksFiles(exported, () => gitleaks("dir", exported, cfgDir, sha));
    let present: string[];
    let presentVia: string;
    if (tree.findings) {
      present = [...new Set(tree.findings.map((f) => f.file))];
      presentVia = "gitleaks over the checked-out commit";
    } else {
      // Conservative: a history finding whose file still exists may still hold the secret.
      const files = [...new Set(history.findings.map((f) => f.file))].slice(0, 50);
      present = [];
      for (const f of files) if ((await git(["cat-file", "-e", `${sha}:${f}`], clone)).code === 0) present.push(f);
      presentVia = `files of history findings that still exist at the commit (tree scan failed: ${tree.problem ?? "unknown"})`;
    }
    return { result: r1Verdict({ history: history.findings, present, presentVia, rotation, evidence }), tool: history.tool };
  }

  // No gitleaks: committed .env files with secret-looking values still decide a fail.
  let secretLines = 0;
  const present: string[] = [];
  if (envFiles.length) {
    const p = await git(["log", sha, "-p", "--", ...envFiles], clone);
    secretLines = p.out.split("\n").filter((l) => /^\+[^+]/.test(l) && ENV_SECRET_LINE.test(l)).length;
    for (const f of envFiles) {
      const now = fileText(files, f);
      if (now && now.split("\n").some((l) => ENV_SECRET_LINE.test(l))) present.push(f);
    }
  }
  return {
    result: r1Verdict({ history: null, present, presentVia: ".env files of the checked-out commit", rotation, envHistory: { files: envFiles, secretLines }, gitleaksProblem: history.problem, evidence }),
    tool: history.tool,
  };
}

// ───────────────────────── R2, R3, R6, R7 ─────────────────────────

function r2(files: RepoFile[]): CheckResult {
  const matches = scanClientSecrets(files);
  const evidence: Evidence = { files_scanned: files.length, matches: matches.slice(0, 20).map((m) => `${m.file}:${m.line} [${m.rule}] ${m.text}`) };
  if (matches.length) return fail("R2", `${matches.length} service-role/secret reference${matches.length === 1 ? "" : "s"} in NEXT_PUBLIC_* names or 'use client' files`, evidence);
  return pass("R2", "No service_role / SERVICE / sb_secret_ in NEXT_PUBLIC_* names or 'use client' files", evidence);
}

const isRealDir = (p: string) => {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  return !!st && st.isDirectory() && !st.isSymbolicLink();
};

/** `[db] major_version` from the candidate's config.toml (a regular file only), if it is one we support. */
function candidateMajorVersion(clone: string): string | null {
  const cfg = path.join(clone, "supabase", "config.toml");
  const st = fs.lstatSync(cfg, { throwIfNoEntry: false });
  if (!st || !st.isFile() || st.size > 200_000) return null;
  const m = fs.readFileSync(cfg, "utf8").match(/^\[db\][^[]*?^\s*major_version\s*=\s*(\d+)/ms);
  return m && ["15", "17"].includes(m[1]) ? m[1] : null;
}

/**
 * Builds a scratch database from the migrations with the Supabase CLI: a private project of our
 * own (our config.toml, project id and port; only the candidate's regular *.sql migration files
 * copied in, symlinks refused), so the candidate's config cannot point the CLI at files outside
 * the repo. Then checks every migration was applied, the tables exist and all have RLS.
 */
async function r3Dynamic(clone: string, tmp: string, staticTables: string[]): Promise<Evidence & { ok: boolean | null; reason?: string }> {
  if (!available("supabase", ["--version"]) && !available("npx", ["--version"])) return { ok: null, reason: "Supabase CLI not available" };
  if (!available("docker", ["info"])) return { ok: null, reason: "Docker not available" };
  const src = path.join(clone, "supabase", "migrations");
  if (!isRealDir(path.join(clone, "supabase")) || !isRealDir(src)) return { ok: null, reason: "supabase/ or supabase/migrations is a symlink or not a folder: not followed" };

  const work = path.join(tmp, "r3");
  const migDir = path.join(work, "supabase", "migrations");
  fs.mkdirSync(migDir, { recursive: true });
  const copied: string[] = [];
  const refused: string[] = [];
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (!e.name.endsWith(".sql")) continue;
    if (!e.isFile()) refused.push(`${e.name} (not a regular file)`);
    else if (!CLI_MIGRATION_NAME.test(e.name)) refused.push(`${e.name} (not <digits>_<name>.sql: the CLI skips it)`);
    else {
      fs.copyFileSync(path.join(src, e.name), path.join(migDir, e.name), fs.constants.COPYFILE_EXCL);
      copied.push(e.name);
    }
  }
  const base: Evidence = { migration_files: copied.length, not_applied: refused.slice(0, 20) };
  if (!copied.length) return { ok: false, reason: "no migration file the Supabase CLI would apply", ...base };

  const cli = available("supabase", ["--version"]) ? ["supabase"] : ["npx", "--yes", "supabase"];
  const projectId = `verify-swe1-${randomBytes(4).toString("hex")}`;
  const port = 56000 + Math.floor(Math.random() * 3000);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME ?? tmp, DOCKER_HOST: process.env.DOCKER_HOST, SUPABASE_TELEMETRY_DISABLED: "1" } as Env;
  const sb = (args: string[], timeoutMs: number) => run(cli[0], [...cli.slice(1), ...args, "--workdir", work], { env, timeoutMs });

  const init = await sb(["init", "--force"], 120_000);
  const cfg = path.join(work, "supabase", "config.toml");
  if (init.code !== 0 || !fs.existsSync(cfg)) return { ok: null, reason: "supabase init failed", output: tail(init.out, 10), ...base };
  // Our own project id and port: never touches another local stack (e.g. the platform's).
  let toml = fs.readFileSync(cfg, "utf8");
  toml = /^\s*project_id\s*=.*$/m.test(toml) ? toml.replace(/^\s*project_id\s*=.*$/m, `project_id = "${projectId}"`) : `project_id = "${projectId}"\n${toml}`;
  if (/^\[db\][^[]*?^\s*port\s*=.*$/ms.test(toml)) toml = toml.replace(/(^\[db\][^[]*?^\s*)port\s*=.*$/ms, `$1port = ${port}`);
  else if (/^\[db\]\s*$/m.test(toml)) toml = toml.replace(/^\[db\]\s*$/m, `[db]\nport = ${port}`);
  else toml += `\n[db]\nport = ${port}\n`;
  toml = toml.replace(/^(\s*shadow_port\s*=).*$/m, `$1 ${port + 1}`);
  const major = candidateMajorVersion(clone);
  if (major) toml = toml.replace(/^(\s*major_version\s*=).*$/m, `$1 ${major}`);
  fs.writeFileSync(cfg, toml);

  // Catalog names qualified and search_path pinned: the candidate's SQL cannot shadow pg_class.
  const pgOptions = "-c search_path=pg_catalog";
  const query = async (sql: string): Promise<string | null> => {
    const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    const viaPsql = available("psql", ["--version"]) ? await run("psql", [url, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { timeoutMs: 60_000, env: { PATH: process.env.PATH, PGOPTIONS: pgOptions } }) : null;
    if (viaPsql?.code === 0) return viaPsql.out;
    const viaDocker = await run("docker", ["exec", "-e", `PGOPTIONS=${pgOptions}`, `supabase_db_${projectId}`, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { timeoutMs: 60_000 });
    return viaDocker.code === 0 ? viaDocker.out : null;
  };
  const appliedCount = async () => {
    const out = await query("select count(*) from supabase_migrations.schema_migrations");
    return out === null ? null : Number(out.trim()) || 0;
  };
  try {
    const start = await sb(["db", "start"], 900_000);
    if (start.code !== 0) {
      // Our infrastructure (ports, image pulls, Docker) failing is not the candidate's fault.
      if (/already allocated|address already in use|pull access denied|toomanyrequests|Cannot connect to the Docker daemon|no space left/i.test(start.out)) {
        return { ok: null, reason: "the scratch database could not start (infrastructure)", output: tail(start.out, 15), ...base };
      }
      return { ok: false, reason: "the database did not start with these migrations (they do not apply cleanly)", output: tail(start.out, 25), ...base };
    }
    let applied = await appliedCount();
    let upOutput: string[] | null = null;
    if (applied !== null && applied < copied.length) {
      const up = await sb(["migration", "up", "--local", "--include-all"], 600_000);
      upOutput = tail(up.out, 25);
      if (up.code !== 0) return { ok: false, reason: "supabase migration up failed", output: upOutput, applied, ...base };
      applied = await appliedCount();
    }
    if (applied === null) return { ok: null, reason: "could not read supabase_migrations.schema_migrations on the scratch database", ...base };
    if (applied < copied.length) return { ok: false, reason: `only ${applied} of ${copied.length} migrations were applied`, applied, ...(upOutput ? { output: upOutput } : {}), ...base };

    const rel = "from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p')";
    const tablesOut = await query(`select c.relname ${rel} order by 1`);
    const noRlsOut = await query(`select c.relname ${rel} and not c.relrowsecurity order by 1`);
    if (tablesOut === null || noRlsOut === null) return { ok: null, reason: "could not query the scratch database", applied, ...base };
    const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
    const tables = lines(tablesOut);
    const noRls = lines(noRlsOut);
    const have = new Set(tables.map((t) => t.toLowerCase()));
    const missing = staticTables.filter((t) => !have.has(t.toLowerCase()));
    const ev: Evidence = { applied, public_tables: tables.length, tables_without_rls: noRls, missing_tables: missing, ...base };
    if (!tables.length) return { ok: false, reason: "the migrations ran but no public table exists afterwards", ...ev };
    if (missing.length) return { ok: false, reason: `tables the migrations create are missing after the reset: ${missing.slice(0, 10).join(", ")}`, ...ev };
    if (noRls.length) return { ok: false, reason: `tables without RLS after reset: ${noRls.slice(0, 10).join(", ")}`, ...ev };
    return { ok: true, ...ev };
  } finally {
    await sb(["stop", "--no-backup"], 180_000);
  }
}

/** Workflow files committed at the SHA (read from git, not the working tree). */
async function r6(clone: string, repo: string, sha: string): Promise<CheckResult> {
  const ls = await git(["ls-tree", "--name-only", sha, "--", ".github/workflows/"], clone);
  const workflows = ls.out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(l))
    .map((l) => l.split("/").pop()!);
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

/** .gitignore rules of the checked-out commit, tracked .env files and .env.example, all from git. */
async function r7(clone: string, sha: string): Promise<CheckResult> {
  const probes = [".env", ".env.local", ".env.production"];
  const ignored: Record<string, boolean> = {};
  for (const p of probes) ignored[p] = (await git(["check-ignore", "-q", "--no-index", p], clone)).code === 0;
  const tracked = (await git(["ls-tree", "-r", "-z", "--name-only", sha], clone)).out.split("\0").filter((f) => /(^|\/)\.env(\.[\w-]+)*$/.test(f) && !/\.(example|sample|template)$/.test(f));
  const example = (await git(["cat-file", "-e", `${sha}:.env.example`], clone)).code === 0;
  // Lists, not a record keyed by file name: results.json evidence keys must be identifiers, so
  // ".env.local" as a key would reach the reviewer as "e_env_local".
  const evidence: Evidence = { gitignored: probes.filter((p) => ignored[p]), not_gitignored: probes.filter((p) => !ignored[p]), env_example: example, tracked_env_files: tracked.slice(0, 20) };
  const allIgnored = probes.every((p) => ignored[p]);
  if (allIgnored && example && !tracked.length) return pass("R7", ".env* is gitignored and .env.example exists", evidence);
  const why = [!allIgnored ? `not gitignored: ${probes.filter((p) => !ignored[p]).join(", ")}` : null, !example ? "no .env.example" : null, tracked.length ? `committed: ${tracked.join(", ")}` : null].filter(Boolean);
  return fail("R7", why.join("; "), evidence);
}

// ───────────────────────── R4 / R5 (candidate code, on the export) ─────────────────────────

interface Step {
  name: string;
  cmd: string;
  timeoutMs: number;
  /** Docker network for the step: the registry for npm ci, nothing for everything after it. */
  network: "bridge" | "none";
}

interface StepResult {
  name: string;
  code: number | null;
  timedOut: boolean;
  ms: number;
  tail: string[];
}

async function execSteps(dir: string, mode: "docker" | "host", steps: Step[], env: Record<string, string>): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const baseEnv: Record<string, string> = { ...env, CI: "true", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: "--max-old-space-size=4096", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
  for (const step of steps) {
    let ran: Ran;
    if (mode === "docker") {
      const name = `verify-swe1-${randomBytes(4).toString("hex")}`;
      const uid = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid?.() ?? 0}` : "1000:1000";
      // Behind a TLS-intercepting proxy the registry needs its CA: pass the (public) CA file through.
      const ca = step.network !== "none" && process.env.NODE_EXTRA_CA_CERTS && fs.existsSync(process.env.NODE_EXTRA_CA_CERTS) ? path.resolve(process.env.NODE_EXTRA_CA_CERTS) : null;
      const caArgs = ca ? ["-v", `${ca}:/etc/verify-swe1-ca.crt:ro`] : [];
      // Nothing from this environment is passed in (no proxy URLs, tokens or keys): only baseEnv.
      const envArgs = Object.entries({ ...baseEnv, HOME: "/tmp/home", npm_config_cache: "/tmp/npm-cache", ...(ca ? { NODE_EXTRA_CA_CERTS: "/etc/verify-swe1-ca.crt" } : {}) }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      ran = await run(
        "docker",
        [
          "run", "--rm", "--name", name, "--network", step.network,
          "--memory", "6g", "--cpus", "2", "--pids-limit", "4096", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--user", uid,
          "-v", `${dir}:/work`, ...caArgs, "-w", "/work", ...envArgs,
          NODE_IMAGE, "sh", "-c", `mkdir -p /tmp/home && ${step.cmd}`,
        ],
        { timeoutMs: step.timeoutMs, onTimeout: () => spawnSync("docker", ["kill", name], { stdio: "ignore" }) },
      );
    } else {
      ran = await run("sh", ["-c", step.cmd], { cwd: dir, timeoutMs: step.timeoutMs, env: { PATH: process.env.PATH, HOME: path.join(os.tmpdir(), "verify-swe1-home"), ...baseEnv } });
    }
    results.push({ name: step.name, code: ran.code, timedOut: ran.timedOut, ms: ran.ms, tail: tail(ran.out, 30) });
    if (ran.code !== 0) break;
  }
  return results;
}

async function r4r5(exported: string, files: RepoFile[], args: Args): Promise<CheckResult[]> {
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
      inconclusive("R4", "not run: the candidate's npm scripts run only in CI or a disposable sandbox (--disposable-sandbox --exec)", { scripts: Object.keys(pkg.scripts ?? {}) }),
      hasTest ? inconclusive("R5", "tests not run (no --exec); see the discovery evidence", testEvidence) : fail("R5", "No npm test script", testEvidence),
    ];
  }
  if (args.execMode === "docker" && !available("docker", ["info"])) {
    const why = "Docker is not available to run the candidate's code in a container (--exec-mode host only in a disposable sandbox)";
    return [inconclusive("R4", why), inconclusive("R5", why, testEvidence)];
  }
  const env = parseEnvExample(fileText(files, ".env.example"));
  const build = await execSteps(exported, args.execMode, [
    { name: "npm ci", cmd: "npm ci", timeoutMs: 600_000, network: "bridge" },
    { name: "npm run lint", cmd: "npm run lint", timeoutMs: 300_000, network: "none" },
    // The project's own TypeScript only: "npx tsc" would fetch an unrelated "tsc" package.
    { name: "tsc --noEmit", cmd: 'if [ -x node_modules/.bin/tsc ]; then node_modules/.bin/tsc --noEmit; else echo "typescript is not installed (no node_modules/.bin/tsc)"; exit 1; fi', timeoutMs: 300_000, network: "none" },
    { name: "npm run build", cmd: "npm run build", timeoutMs: 900_000, network: "none" },
  ], env);
  const r4Evidence: Evidence = {
    steps: build.map((s) => ({ step: s.name, exit: s.code, timed_out: s.timedOut, seconds: Math.round(s.ms / 1000) })),
    env_from_example: Object.keys(env),
    sandbox: args.execMode === "docker" ? `${NODE_IMAGE}; npm ci with the registry, later steps with --network none` : "host (disposable sandbox)",
  };
  const failed = build.find((s) => s.code !== 0);
  const results: CheckResult[] = [];
  if (failed) {
    r4Evidence.output = failed.tail;
    results.push(fail("R4", `${failed.name} ${failed.timedOut ? "timed out" : `exited ${failed.code}`}`, r4Evidence));
  } else results.push(pass("R4", "npm ci, lint, tsc --noEmit and build all exit 0", r4Evidence));

  if (!hasTest) results.push(fail("R5", "No npm test script", testEvidence));
  else if (build[0]?.code !== 0) results.push(inconclusive("R5", "dependencies did not install (see R4), so the tests could not run", testEvidence));
  else {
    const t = (await execSteps(exported, args.execMode, [{ name: "npm test", cmd: "npm test", timeoutMs: 600_000, network: "none" }], env))[0];
    const ev: Evidence = { ...testEvidence, exit: t.code, timed_out: t.timedOut, seconds: Math.round(t.ms / 1000), output: t.tail.slice(-15) };
    if (t.code !== 0) results.push(fail("R5", `npm test ${t.timedOut ? "timed out" : `exited ${t.code}`} (run without network access)`, ev));
    else if (!tests.importTests.length || !tests.rd07Tests.length)
      results.push(fail("R5", `Tests pass, but none covers ${[!tests.importTests.length ? "the import" : null, !tests.rd07Tests.length ? "RD-07 (callback date)" : null].filter(Boolean).join(" or ")}`, ev));
    else results.push(pass("R5", `npm test passes; ${tests.importTests.length} test file(s) cover the import and ${tests.rd07Tests.length} cover RD-07`, ev));
  }
  return results;
}

// ───────────────────────── Main ─────────────────────────

export async function repoChecks(args: Args): Promise<{ checks: CheckResult[]; tools: Record<string, string> }> {
  if ((args.exec || args.dbReset) && !args.disposableSandbox) throw new Error(SANDBOX_REFUSAL);
  dockerDisabled = args.noDocker;
  // Always a fresh folder of our own (inside --workdir when given), so cleaning up never deletes
  // anything we did not create.
  if (args.workdir) fs.mkdirSync(args.workdir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(args.workdir ?? os.tmpdir(), "verify-swe1-"));
  const clone = path.join(tmp, "repo");
  const exported = path.join(tmp, "export");
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
    // The tree the candidate's code will run on: the commit's files without .git.
    const ex = await git(["checkout-index", "--all", "--force", `--prefix=${exported}/`], clone);
    if (ex.code !== 0) return { checks: all(`could not export the commit (${tail(ex.out, 3).join(" ").slice(0, 200)})`), tools };

    // ── Phase 1: everything that reads the tree or runs git, before any candidate code ──
    const files = readTree(clone);
    const checks: CheckResult[] = [];

    const leaks = await r1(clone, exported, args.sha, files, tmp);
    tools.gitleaks = leaks.tool;
    checks.push(leaks.result);
    checks.push(r2(files));

    const st = analyseMigrations(files);
    const dirExists = isRealDir(path.join(clone, "supabase", "migrations"));
    const r3Evidence: Evidence = { migrations_dir: dirExists, migration_files: st.files.length, not_applied_by_cli: st.notApplied, tables: st.tables, without_rls: st.withoutRls, disabled_later: st.disabledLater };
    let r3: CheckResult;
    if (!dirExists || !st.files.length) r3 = fail("R3", "No supabase/migrations/*.sql: the schema is not reproducible", r3Evidence);
    else if (st.notApplied.length) r3 = fail("R3", `${st.notApplied.length} file(s) in supabase/migrations are not named <timestamp>_<name>.sql, so \`supabase db reset\` skips them: ${st.notApplied.slice(0, 5).map((p) => p.split("/").pop()).join(", ")}`, r3Evidence);
    else if (!st.tables.length) r3 = fail("R3", "The migrations create no public tables", r3Evidence);
    else if (st.withoutRls.length) r3 = fail("R3", `Tables without RLS in the migrations: ${st.withoutRls.join(", ")}`, r3Evidence);
    else r3 = pass("R3", `${st.files.length} migrations; all ${st.tables.length} public tables enable RLS (static)`, r3Evidence, args.dbReset ? undefined : "static check only: the full db reset runs in CI (--db-reset)");
    if (args.dbReset && r3.passed !== false) {
      const { ok, reason, ...rest } = await r3Dynamic(clone, tmp, st.tables);
      r3Evidence.db_reset = rest as Evidence;
      if (ok === true) r3 = pass("R3", `${st.files.length} migrations apply cleanly on a scratch database and all ${String(rest.public_tables)} public tables have RLS`, r3Evidence);
      else if (ok === false) r3 = fail("R3", `db reset: ${reason}`, r3Evidence);
      else r3 = { ...r3, detail: { ...r3.detail, evidence: r3Evidence, reviewer_note: `static check passed; the db reset could not run (${reason})` } };
    }
    checks.push(r3);
    checks.push(await r6(clone, args.repo, args.sha));
    checks.push(await r7(clone, args.sha));

    // ── Phase 2: the candidate's code, on the export only ──
    checks.push(...(await r4r5(exported, files, args)));

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
