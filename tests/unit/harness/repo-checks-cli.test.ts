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

const args = (r: { dir: string; sha: string }): Args => ({ repo: r.dir, sha: r.sha, out: "", workdir: null, exec: false, execMode: "docker", dbReset: false, keep: false, noDocker: true });
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
    expect(c.R1.passed).toBe(true);
    expect(c.R1.detail.reviewer_note).toBeTruthy();
    expect(c.R2.passed).toBe(true);
    expect(c.R3.passed).toBe(true);
    expect(c.R6.passed).toBeNull(); // workflows exist; a local repo has no CI status
    expect(c.R7.passed).toBe(true);
  }, 60_000);

  it("reports every check inconclusive when the commit is not in the repo", async () => {
    const r = repo([{ "package.json": PKG }]);
    const { checks } = await repoChecks({ ...args(r), sha: "f".repeat(40) });
    expect(checks.every((x) => x.passed === null)).toBe(true);
    expect(checks[0].detail.summary).toMatch(/not in the repository/);
  }, 60_000);
});
