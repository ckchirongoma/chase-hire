import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildArtifact } from "@/lib/harness/artifact";
import type { CheckResult } from "@/lib/harness/checks";
import { repoChecks, type Args } from "../../../scripts/verify-swe1/repo-checks";

/** Static repo checks against throwaway local git repos (no Docker, no candidate code run). */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repo(commits: Record<string, string | null>[]): { dir: string; sha: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-fixture-"));
  dirs.push(dir);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.co.za", "-c", "init.defaultBranch=main", ...a], { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  for (const files of commits) {
    for (const [p, content] of Object.entries(files)) {
      const abs = path.join(dir, p);
      if (content === null) fs.rmSync(abs, { force: true });
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
    }
    git("add", "-A");
    git("commit", "-q", "-m", "change");
  }
  return { dir, sha: git("rev-parse", "HEAD").trim() };
}

const args = (r: { dir: string; sha: string }): Args => ({ repo: r.dir, sha: r.sha, out: "", workdir: null, exec: false, execMode: "docker", dbReset: false, keep: false, noDocker: true, disposableSandbox: false });
const byKey = (checks: CheckResult[]): Record<string, CheckResult> => Object.fromEntries(checks.map((c) => [c.key, c]));
// A fake, high-entropy value generated at run time (never committed anywhere).
const fakeSecret = () => randomBytes(24).toString("base64url");

const PKG = JSON.stringify({ name: "desk", scripts: { lint: "eslint", build: "next build", test: "vitest run" } });

describe("repo-checks.ts (static)", () => {
  it("fails the planted-fault starter's history and layout", async () => {
    const r = repo([
      { "package.json": PKG, ".env.local": `OPENROUTER_API_KEY=${fakeSecret()}\n`, "README.md": "# Desk\n" },
      {
        ".env.local": null,
        "supabase/migrations/001_init.sql": "create table customers (id uuid);\ncreate table interactions (id uuid);\nalter table interactions enable row level security;",
        "components/AdminPanel.tsx": `"use client";\nconst k = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_KEY;`,
        ".gitignore": "node_modules\n",
      },
    ]);
    const { checks } = await repoChecks(args(r));
    const c = byKey(checks);
    expect(c.R1.passed).toBe(false);
    expect(c.R1.detail.summary).toMatch(/\.env\.local/);
    expect(c.R2.passed).toBe(false);
    expect(c.R3).toMatchObject({ passed: false, detail: { summary: expect.stringMatching(/customers/) } });
    expect(c.R4.passed).toBeNull();
    expect(c.R5.passed).toBeNull();
    expect(c.R6.passed).toBe(false);
    expect(c.R7.passed).toBe(false);
    // What the CI job uploads is accepted by the report job's schema.
    expect(buildArtifact({ repoUrl: r.dir, sha: r.sha, checks }).checks).toHaveLength(7);
  }, 60_000);

  it("passes a hardened repo (rotation documented, RLS everywhere, env ignored)", async () => {
    const r = repo([
      { "package.json": PKG, ".env.local": `SUPABASE_SECRET_KEY=${fakeSecret()}\n` },
      {
        ".env.local": null,
        "README.md": "## Found and fixed\n- F13: the key committed in .env.local was rotated in the Supabase dashboard and the old one revoked.\n",
        ".gitignore": ".env*\n!.env.example\n",
        ".env.example": "NEXT_PUBLIC_SUPABASE_URL=\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=\nSUPABASE_SECRET_KEY=\n",
        "supabase/migrations/001_init.sql": "create table public.customers (id uuid);\nalter table public.customers enable row level security;",
        ".github/workflows/ci.yml": "on: push\njobs: {}\n",
        "tests/import.test.ts": `describe("import", () => { it("is idempotent", () => {}) })`,
        "tests/outcomes.test.ts": `it("needs a callback date for call_back", () => {})`,
      },
    ]);
    const { checks } = await repoChecks(args(r));
    const c = byKey(checks);
    // Without gitleaks the history scan is incomplete: a documented rotation is for a reviewer to confirm.
    expect(c.R1).toMatchObject({ passed: null, detail: { inconclusive: true, summary: expect.stringMatching(/gitleaks did not run/) } });
    expect(c.R2.passed).toBe(true);
    expect(c.R3.passed).toBe(true);
    expect(c.R6.passed).toBeNull(); // workflows exist; a local repo has no CI status
    expect(c.R7.passed).toBe(true);
  }, 60_000);

  it("fails R1 when a secret is still in the graded commit, whatever the README says", async () => {
    const r = repo([
      { "package.json": PKG, ".env.production": `OPENROUTER_API_KEY=${fakeSecret()}\n`, "README.md": "## Security\nThe key was rotated in the dashboard.\n" },
    ]);
    const c = byKey((await repoChecks(args(r))).checks);
    expect(c.R1).toMatchObject({ passed: false, detail: { summary: expect.stringMatching(/still in the graded commit.*\.env\.production/) } });
  }, 60_000);

  it("fails R3 when the migrations are not files the Supabase CLI applies (F07 moved into migrations/)", async () => {
    const r = repo([{ "package.json": PKG, "supabase/migrations/schema.sql": "create table public.customers (id uuid);\nalter table public.customers enable row level security;" }]);
    const c = byKey((await repoChecks(args(r))).checks);
    expect(c.R3).toMatchObject({ passed: false, detail: { summary: expect.stringMatching(/not named <timestamp>_<name>\.sql.*schema\.sql/) } });
  }, 60_000);

  it("refuses to run candidate code (--exec, --db-reset) unless the machine is a disposable sandbox", async () => {
    const r = repo([{ "package.json": PKG }]);
    await expect(repoChecks({ ...args(r), exec: true })).rejects.toThrow(/disposable-sandbox/);
    await expect(repoChecks({ ...args(r), dbReset: true })).rejects.toThrow(/disposable-sandbox/);
  }, 60_000);

  it("reports every check inconclusive when the commit is not in the repo", async () => {
    const r = repo([{ "package.json": PKG }]);
    const { checks } = await repoChecks({ ...args(r), sha: "f".repeat(40) });
    expect(checks.every((x) => x.passed === null)).toBe(true);
    expect(checks[0].detail.summary).toMatch(/not in the repository/);
  }, 60_000);
});

// Runs only where the pinned images are already present (never pulls them in a unit run).
const hasImage = (image: string) => {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
};
const gitleaksImage = hasImage("zricethezav/gitleaks:v8.24.2");
const nodeImage = hasImage("node:22-bookworm");

/**
 * The blocker: candidate code (an npm preinstall script) tries to plant core.fsmonitor in .git
 * (the clone's, via a relative path, and its own) and to add .env.example / .gitignore. The
 * checks that read the tree or run git must already have finished, and git must never run a
 * command from the repo.
 */
function hostileRepo(): { r: { dir: string; sha: string }; marker: string } {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "verify-poc-"));
  dirs.push(outside);
  const marker = path.join(outside, "hook-ran");
  const hook = path.join(outside, "hook.sh");
  fs.writeFileSync(hook, `#!/bin/sh\necho "ran: $(pwd)" >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  const evil = `const fs = require("fs");
for (const dir of [".git", "../repo/.git"]) { try { fs.appendFileSync(dir + "/config", "\\n[core]\\n\\tfsmonitor = ${hook}\\n"); } catch {} }
fs.writeFileSync(".env.example", "X=1\\n");
fs.writeFileSync(".gitignore", ".env*\\n");
fs.writeFileSync("saw-git.txt", String(fs.existsSync(".git")));
`;
  const pkg = JSON.stringify({ name: "poc", version: "1.0.0", scripts: { preinstall: "node evil.js", lint: "node -e 0", build: "node -e 0", test: "node -e 0" } });
  const lock = JSON.stringify({ name: "poc", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "poc", version: "1.0.0" } } });
  const r = repo([{ "package.json": pkg, "package-lock.json": lock, "evil.js": evil, "README.md": "# PoC\n" }]);
  return { r, marker };
}

describe("repo-checks.ts with candidate code (--exec)", () => {
  it("judges git and the tree before the candidate's code runs, on an export without .git (host mode)", async () => {
    const { r, marker } = hostileRepo();
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-work-"));
    dirs.push(workdir);
    const { checks } = await repoChecks({ ...args(r), exec: true, execMode: "host", disposableSandbox: true, workdir, keep: true });
    const c = byKey(checks);
    // The commit has neither .env.example nor an .env* rule, whatever the preinstall script wrote.
    expect(c.R7).toMatchObject({ passed: false, detail: { summary: expect.stringMatching(/no \.env\.example/) } });
    expect(c.R4.passed).toBe(false); // ran (preinstall ok), then no TypeScript
    expect(fs.existsSync(marker)).toBe(false);
    const tmp = fs.readdirSync(workdir).map((d) => path.join(workdir, d))[0];
    expect(fs.readFileSync(path.join(tmp, "export", "saw-git.txt"), "utf8")).toBe("false");
    // The script reached the clone's .git/config (host mode is for sandboxes only), but no git ran after it.
    expect(fs.readFileSync(path.join(tmp, "repo", ".git", "config"), "utf8")).toMatch(/fsmonitor/);
  }, 120_000);

  it.skipIf(!nodeImage)("runs the candidate's npm scripts in a container that sees only the export (docker mode)", async () => {
    const { r, marker } = hostileRepo();
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-work-"));
    dirs.push(workdir);
    const { checks } = await repoChecks({ ...args(r), noDocker: false, exec: true, execMode: "docker", disposableSandbox: true, workdir, keep: true });
    const c = byKey(checks);
    expect(c.R7.passed).toBe(false);
    expect(c.R4).toMatchObject({ passed: false, detail: { summary: expect.stringMatching(/tsc/) } });
    expect(fs.existsSync(marker)).toBe(false);
    const tmp = fs.readdirSync(workdir).map((d) => path.join(workdir, d))[0];
    expect(fs.readFileSync(path.join(tmp, "export", "saw-git.txt"), "utf8")).toBe("false");
    expect(fs.readFileSync(path.join(tmp, "repo", ".git", "config"), "utf8")).not.toMatch(/fsmonitor/);
  }, 240_000);
});

describe("repo-checks.ts gitleaks rules", () => {
  it.skipIf(!gitleaksImage)("finds the committed .env.local but not blank or placeholder .env.example values", async () => {
    const r = repo([
      { "package.json": PKG, ".env.local": `OPENROUTER_API_KEY=${fakeSecret()}\n` },
      {
        ".env.local": null,
        // Blank values used to swallow the next line as the "secret" (\s* crossed the newline).
        ".env.example": "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=\nNEXT_PUBLIC_SUPABASE_SERVICE_KEY=\nSUPABASE_SECRET_KEY=your-secret-key-goes-here\n",
      },
    ]);
    const { checks, tools } = await repoChecks({ ...args(r), noDocker: false });
    expect(tools.gitleaks).toMatch(/gitleaks/);
    const r1 = byKey(checks).R1;
    expect(r1.passed).toBe(false);
    const examples = (r1.detail.evidence as { examples: string[] }).examples;
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.every((e) => /\.env\.local/.test(e))).toBe(true);
  }, 120_000);

  it.skipIf(!gitleaksImage)("passes a secret only in history when the README says it was rotated; fails a deferred or negated rotation", async () => {
    const history = { "package.json": PKG, ".env.local": `OPENROUTER_API_KEY=${fakeSecret()}\n` };
    const rotated = repo([history, { ".env.local": null, "README.md": "## Security\n- F13: the key committed in .env.local was rotated in the OpenRouter dashboard.\n" }]);
    const c1 = byKey((await repoChecks({ ...args(rotated), noDocker: false })).checks);
    expect(c1.R1).toMatchObject({ passed: true, detail: { reviewer_note: expect.stringMatching(/rotated but not rewritten/) } });

    const deferred = repo([history, { ".env.local": null, "README.md": "Key rotation is out of scope for this submission; the old key was never rotated.\n" }]);
    const c2 = byKey((await repoChecks({ ...args(deferred), noDocker: false })).checks);
    expect(c2.R1).toMatchObject({ passed: false, detail: { summary: expect.stringMatching(/does not say the key was rotated/) } });

    // Still at the graded commit: a rotation note does not excuse it.
    const shipped = repo([{ ...history, ".env.production": `SUPABASE_SECRET_KEY=${fakeSecret()}\n`, "README.md": "The key was rotated.\n" }]);
    const c3 = byKey((await repoChecks({ ...args(shipped), noDocker: false })).checks);
    expect(c3.R1).toMatchObject({ passed: false, detail: { summary: expect.stringMatching(/still in the graded commit/) } });
    expect((c3.R1.detail.evidence as { present_checked_via: string }).present_checked_via).toMatch(/gitleaks/);
  }, 240_000);
});
