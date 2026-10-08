import { describe, expect, it } from "vitest";
import { analyseMigrations, ciVerdict, envFilesInHistory, findTests, parseEnvExample, parseGitleaksReport, rotationDocumented, scanClientSecrets, tail } from "@/lib/harness/repo-rules";

const f = (path: string, content: string) => ({ path, content });

describe("R3: every table in the migrations enables RLS", () => {
  it("replays create / enable / rename / drop in filename order", () => {
    const a = analyseMigrations([
      f("supabase/migrations/002_more.sql", `alter table public.customers enable row level security;\nalter table "Lines" rename to lines2;\ndrop table if exists scratch;`),
      f(
        "supabase/migrations/001_init.sql",
        `-- create table commented_out (id int);\ncreate table if not exists public.customers (id uuid);\ncreate table "Lines" (id uuid);\nalter table only "Lines" enable row level security;\ncreate table scratch (id int);\ncreate table auth.other (id int);\ncreate temp table t (id int);\ncreate table interactions (id uuid);`,
      ),
      f("supabase/seed.sql", "create table not_a_migration (id int);"),
    ]);
    expect(a.files).toEqual(["supabase/migrations/001_init.sql", "supabase/migrations/002_more.sql"]);
    expect(a.tables).toEqual(["customers", "interactions", "lines2"]);
    expect(a.withoutRls).toEqual(["interactions"]);
  });

  it("catches RLS disabled later (F01)", () => {
    const a = analyseMigrations([
      f("supabase/migrations/1.sql", "create table customers (id int); alter table customers enable row level security;"),
      f("supabase/migrations/2.sql", "ALTER TABLE public.customers DISABLE ROW LEVEL SECURITY;"),
    ]);
    expect(a.withoutRls).toEqual(["customers"]);
    expect(a.disabledLater).toEqual(["customers"]);
  });
});

describe("R2: secrets in client code", () => {
  it("flags NEXT_PUBLIC_*SERVICE* names and service-role use in 'use client' files only", () => {
    const m = scanClientSecrets([
      f("components/AdminPanel.tsx", `"use client";\nimport { createClient } from "@supabase/supabase-js";\nconst c = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_SERVICE_KEY!);`),
      f("components/Queue.tsx", `'use client'\n// service_role is never used here\nexport const role = "service_role";`),
      f("lib/server/admin.ts", `const key = process.env.SUPABASE_SERVICE_ROLE_KEY;`),
      f(".env.example", `NEXT_PUBLIC_SUPABASE_URL=\nSUPABASE_SECRET_KEY=`),
      f("README.md", `We removed NEXT_PUBLIC_SUPABASE_SERVICE_KEY.`),
      f("tests/admin.test.ts", `"use client"; const x = "service_role";`),
    ]);
    expect(m.map((x) => `${x.file}:${x.line}:${x.rule}`)).toEqual(["components/AdminPanel.tsx:3:public_env_secret", "components/Queue.tsx:3:client_secret_reference"]);
  });
});

describe("R5: test discovery", () => {
  it("finds import and RD-07 tests by name and title", () => {
    const t = findTests([
      f("tests/import.test.ts", `describe("monthly import", () => { it("is idempotent", () => {}) })`),
      f("src/outcomes.spec.ts", `it("rejects call_back without a date", () => {})`),
      f("src/util.test.ts", `import { x } from "./x"; test("adds", () => {})`),
      f("node_modules/pkg/import.test.js", `test("import", () => {})`),
    ]);
    expect(t.testFiles).toEqual(["tests/import.test.ts", "src/outcomes.spec.ts", "src/util.test.ts"]);
    expect(t.importTests).toEqual(["tests/import.test.ts"]);
    expect(t.rd07Tests).toEqual(["src/outcomes.spec.ts"]);
  });
});

describe("R1, R6, R7 helpers", () => {
  it("recognises a documented rotation, not a plan to rotate", () => {
    expect(rotationDocumented("## Security\nThe OpenRouter key from the old .env.local was rotated on 7 Oct.").documented).toBe(true);
    expect(rotationDocumented("We should rotate the key at some point.").documented).toBe(false);
    expect(rotationDocumented(null).documented).toBe(false);
  });

  it("lists .env files ever added, ignoring examples", () => {
    expect(envFilesInHistory("\n.env.local\nsrc/a.ts\n.env.example\napps/web/.env.production\n.env.local\n")).toEqual([".env.local", "apps/web/.env.production"]);
  });

  it("parses gitleaks' report without keeping secrets", () => {
    const r = parseGitleaksReport([{ RuleID: "generic-api-key", File: ".env.local", Commit: "abcdef1234567890", StartLine: 2, Secret: "REDACTED" }]);
    expect(r).toEqual([{ rule: "generic-api-key", file: ".env.local", commit: "abcdef123456", line: 2 }]);
    expect(parseGitleaksReport({})).toEqual([]);
  });

  it("judges the latest run of each workflow", () => {
    const run = (workflow_id: number, conclusion: string | null, created_at: string, status = "completed") => ({ name: `w${workflow_id}`, workflow_id, status, conclusion, created_at });
    expect(ciVerdict([]).verdict).toBe("none");
    expect(ciVerdict([run(1, "failure", "2026-10-01"), run(1, "success", "2026-10-02"), run(2, "skipped", "2026-10-02")]).verdict).toBe("green");
    expect(ciVerdict([run(1, "success", "2026-10-01"), run(2, "failure", "2026-10-02")]).verdict).toBe("red");
    expect(ciVerdict([run(1, null, "2026-10-02", "in_progress")]).verdict).toBe("pending");
  });

  it("parses .env.example into placeholder build env", () => {
    expect(parseEnvExample(`# comment\nNEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\nexport OPENROUTER_MODEL="openai/gpt-4o-mini" # cheap\nlowercase=ignored\nEMPTY=`)).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      OPENROUTER_MODEL: "openai/gpt-4o-mini",
      EMPTY: "",
    });
  });

  it("keeps the tail of command output, without ANSI codes or tokens", () => {
    const t = tail("\u001b[31merror\u001b[0m one\nline two eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl\n", 5);
    expect(t).toEqual(["error one", "line two eyJ…[redacted]"]);
  });
});
