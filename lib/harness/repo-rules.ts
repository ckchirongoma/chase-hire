/**
 * Pure rules behind the repo checks (R1–R7). scripts/verify-swe1/repo-checks.ts gathers files
 * and command results from a clone; these functions decide. Nothing here runs candidate code.
 */

export interface RepoFile {
  path: string;
  content: string;
}

const SKIP_DIR = /(^|\/)(node_modules|\.git|\.next|\.vercel|dist|build|out|coverage|\.turbo|supabase\/\.temp)(\/|$)/;
export const isSourcePath = (p: string) => !SKIP_DIR.test(p) && /\.(?:[cm]?[jt]sx?|json|env[\w.-]*|example|toml|ya?ml|md|sql)$|(^|\/)\.env[\w.-]*$/.test(p) && !/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(p);

// ───────────────────────── R1: gitleaks + rotation note ─────────────────────────

export interface GitleaksFinding {
  rule: string;
  file: string;
  commit: string;
  line: number | null;
}

/** Reads gitleaks' JSON report (an array of findings); secrets are never kept (run with --redact). */
export function parseGitleaksReport(json: unknown): GitleaksFinding[] {
  if (!Array.isArray(json)) return [];
  return json.slice(0, 500).map((f) => {
    const o = (f ?? {}) as Record<string, unknown>;
    return {
      rule: String(o.RuleID ?? o.rule ?? "unknown").slice(0, 80),
      file: String(o.File ?? o.file ?? "").slice(0, 200),
      commit: String(o.Commit ?? o.commit ?? "").slice(0, 12),
      line: typeof o.StartLine === "number" ? o.StartLine : null,
    };
  });
}

/** Does the README say the leaked key was rotated (revoked / regenerated / replaced)? */
export function rotationDocumented(readme: string | null): { documented: boolean; quote: string | null } {
  if (!readme) return { documented: false, quote: null };
  const sentences = readme.replace(/\r/g, "").split(/(?<=[.!?])\s+|\n+/);
  const verb = /\b(rotat(?:e|ed|ing|ion)|revok(?:e|ed|ing)|regenerat(?:e|ed|ing)|reissu(?:e|ed)|roll(?:ed)?\s+(?:the\s+)?(?:key|secret)s?|invalidat(?:e|ed))\b/i;
  const noun = /\b(keys?|secrets?|credentials?|tokens?|service[\s_-]?role|\.env|api\s*key|password)\b/i;
  const hit = sentences.find((s) => verb.test(s) && noun.test(s) && !/\b(should|would|todo|need to|not yet|didn'?t|did not)\b/i.test(s));
  return { documented: !!hit, quote: hit ? hit.trim().slice(0, 300) : null };
}

/** .env files (other than examples) ever added in history, from `git log --diff-filter=A --name-only`. */
export function envFilesInHistory(nameOnlyLog: string): string[] {
  return [
    ...new Set(
      nameOnlyLog
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /(^|\/)\.env(\.[\w-]+)*$/.test(l) && !/\.(example|sample|template|dist)$/i.test(l)),
    ),
  ];
}

// ───────────────────────── R2: secrets in client code ─────────────────────────

export interface R2Match {
  file: string;
  line: number;
  rule: "public_env_secret" | "client_secret_reference";
  text: string;
}

const USE_CLIENT = /^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*\s*["']use client["']/;
const PUBLIC_SECRET_NAME = /\bNEXT_PUBLIC_[A-Z0-9_]*(?:SERVICE|SECRET|SERVICE_ROLE|PRIVATE)[A-Z0-9_]*\b/g;
const CLIENT_SECRET_REF = /service_role|SERVICE|sb_secret_/;
/** Code, env and config files (docs such as README.md may legitimately name the old variable). */
const R2_PATH = /\.(?:[cm]?[jt]sx?|json|toml|ya?ml)$|(^|\/)\.env[\w.-]*$/;

/**
 * R2: no service_role / SERVICE / sb_secret_ in NEXT_PUBLIC_* names or in 'use client' files.
 * Matches are evidence for a reviewer (file:line and the line, secrets redacted).
 */
export function scanClientSecrets(files: RepoFile[]): R2Match[] {
  const out: R2Match[] = [];
  for (const f of files) {
    if (!isSourcePath(f.path) || !R2_PATH.test(f.path) || /(^|\/)(tests?|__tests__|e2e)\//.test(f.path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f.path)) continue;
    const isClient = /\.[cm]?[jt]sx?$/.test(f.path) && USE_CLIENT.test(f.content);
    const lines = f.content.split("\n");
    lines.forEach((text, i) => {
      if (/^\s*(?:\/\/|#|\*)/.test(text) && !/NEXT_PUBLIC_/.test(text)) return;
      const publicHit = text.match(PUBLIC_SECRET_NAME);
      if (publicHit && !/^\s*#/.test(text)) {
        out.push({ file: f.path, line: i + 1, rule: "public_env_secret", text: redactLine(text) });
        return;
      }
      if (isClient && CLIENT_SECRET_REF.test(text)) out.push({ file: f.path, line: i + 1, rule: "client_secret_reference", text: redactLine(text) });
    });
  }
  return out.slice(0, 50);
}

function redactLine(s: string): string {
  return s
    .trim()
    .replace(/(=\s*["']?)[A-Za-z0-9_\-.]{16,}/g, "$1…[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "eyJ…[redacted]")
    .slice(0, 200);
}

// ───────────────────────── R3: migrations + RLS (static) ─────────────────────────

export interface MigrationAnalysis {
  files: string[];
  tables: string[];
  withoutRls: string[];
  disabledLater: string[];
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const QNAME = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)`;

function tableName(q: string): { schema: string; name: string } {
  const parts = q.split(".").map((p) => p.trim().replace(/^"|"$/g, ""));
  return parts.length === 2 ? { schema: parts[0].toLowerCase(), name: parts[1].toLowerCase() } : { schema: "public", name: parts[0].toLowerCase() };
}

/**
 * Every table created in the public schema must end up with RLS enabled, replaying the
 * migrations in filename order (create, rename, drop, enable/disable RLS).
 */
export function analyseMigrations(files: RepoFile[]): MigrationAnalysis {
  const sorted = files.filter((f) => /^supabase\/migrations\/[^/]+\.sql$/.test(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  const rls = new Map<string, boolean>();
  const disabledLater = new Set<string>();
  const stmtRe = new RegExp(
    [
      String.raw`create\s+(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${QNAME}`,
      String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${QNAME}\s+(enable|disable)\s+row\s+level\s+security`,
      String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${QNAME}\s+rename\s+to\s+(${IDENT})`,
      String.raw`drop\s+table\s+(?:if\s+exists\s+)?${QNAME}`,
    ].join("|"),
    "gi",
  );
  for (const f of sorted) {
    const sql = stripSqlComments(f.content);
    for (const m of sql.matchAll(stmtRe)) {
      const [, created, altered, toggle, renamed, newName, dropped] = m;
      if (created) {
        if (/^\s*create\s+(?:(?:global|local)\s+)?temp/i.test(m[0])) continue;
        const t = tableName(created);
        if (t.schema === "public") rls.set(t.name, rls.get(t.name) ?? false);
      } else if (altered) {
        const t = tableName(altered);
        if (t.schema !== "public" || !rls.has(t.name)) continue;
        const on = toggle.toLowerCase() === "enable";
        if (!on && rls.get(t.name)) disabledLater.add(t.name);
        rls.set(t.name, on);
      } else if (renamed) {
        const t = tableName(renamed);
        if (t.schema !== "public" || !rls.has(t.name)) continue;
        const state = rls.get(t.name)!;
        rls.delete(t.name);
        rls.set(newName.replace(/^"|"$/g, "").toLowerCase(), state);
      } else if (dropped) {
        const t = tableName(dropped);
        if (t.schema === "public") rls.delete(t.name);
      }
    }
  }
  const tables = [...rls.keys()].sort();
  return { files: sorted.map((f) => f.path), tables, withoutRls: tables.filter((t) => !rls.get(t)), disabledLater: [...disabledLater].filter((t) => !rls.get(t)) };
}

// ───────────────────────── R5: tests for the import and RD-07 ─────────────────────────

export interface TestDiscovery {
  testFiles: string[];
  importTests: string[];
  rd07Tests: string[];
}

const TEST_FILE = /(^|\/)(__tests__\/.*|.*\.(?:test|spec)\.[cm]?[jt]sx?)$|(^|\/)tests?\/.*\.[cm]?[jt]sx?$/;
const TITLE = /\b(?:describe|it|test|context)(?:\.\w+)?\s*\(\s*(["'`])([\s\S]{1,200}?)\1/g;

export function findTests(files: RepoFile[]): TestDiscovery {
  const testFiles = files.filter((f) => !SKIP_DIR.test(f.path) && TEST_FILE.test(f.path) && /\.[cm]?[jt]sx?$/.test(f.path));
  const importTests: string[] = [];
  const rd07Tests: string[] = [];
  for (const f of testFiles) {
    const titles = [...f.content.matchAll(TITLE)].map((m) => m[2]).join("\n");
    const name = f.path.toLowerCase();
    if (/import|ingest|month[-_ ]?2|upload|xlsx/.test(name.split("/").pop() ?? "") || /\b(import(?:s|er|ing)?|ingest\w*|idempot\w*|month[- ]?2|quarantin\w*|xlsx|re-?run|upsert)\b/i.test(titles)) importTests.push(f.path);
    if (/rd[-_]?07|call[-_]?back|outcome/.test(name) || /\b(RD-?07|call[ _-]?back|callback|next[ _]?action\w*)\b/i.test(titles) || /\bRD-?07\b|\bcall_back\b/.test(f.content)) rd07Tests.push(f.path);
  }
  return { testFiles: testFiles.map((f) => f.path), importTests, rd07Tests };
}

// ───────────────────────── R4 / R5 support ─────────────────────────

/** KEY=value pairs from .env.example, used as placeholder env for the candidate's build. */
export function parseEnvExample(text: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]{0,63})\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    const quoted = v.match(/^(["'])(.*?)\1(?:\s+#.*)?$/);
    v = quoted ? quoted[2] : v.replace(/\s+#.*$/, "");
    if (v.length > 500) continue;
    out[m[1]] = v;
  }
  return out;
}

/** Last lines of a command's output, ANSI stripped and redacted, for evidence. */
export function tail(output: string, lines = 40): string[] {
  return output
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter(Boolean)
    .slice(-lines)
    .map((l) =>
      l
        .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "eyJ…[redacted]")
        .replace(/\bsb_secret_[A-Za-z0-9_-]+/g, "sb_secret_…[redacted]")
        .slice(0, 240),
    );
}

// ───────────────────────── R6: CI status ─────────────────────────

export interface WorkflowRunLite {
  name: string;
  workflow_id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url?: string;
}

/**
 * "The last run on the SHA is green": the latest run of each workflow for that commit must have
 * concluded success (or skipped/neutral). Still running → inconclusive.
 */
export function ciVerdict(runs: WorkflowRunLite[]): { verdict: "green" | "red" | "pending" | "none"; latest: { name: string; conclusion: string | null; status: string }[] } {
  if (!runs.length) return { verdict: "none", latest: [] };
  const byWorkflow = new Map<number, WorkflowRunLite>();
  for (const r of [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at))) if (!byWorkflow.has(r.workflow_id)) byWorkflow.set(r.workflow_id, r);
  const latest = [...byWorkflow.values()].map((r) => ({ name: r.name, conclusion: r.conclusion, status: r.status }));
  if (latest.some((r) => r.status !== "completed")) return { verdict: "pending", latest };
  const ok = (c: string | null) => c === "success" || c === "skipped" || c === "neutral";
  return { verdict: latest.every((r) => ok(r.conclusion)) ? "green" : "red", latest };
}
