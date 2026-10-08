import { describe, expect, it } from "vitest";
import { buildArtifact, flattenEvidence, parseArtifact } from "@/lib/harness/artifact";
import { fail, inconclusive, informational, MAX_DETAIL_BYTES, pass, redactSecrets, shapeDetail, toRunRow } from "@/lib/harness/checks";

const SHA = "a".repeat(40);
const REPO = "https://github.com/candidate/kopano-desk";
const valid = () => buildArtifact({ repoUrl: REPO, sha: SHA, checks: [pass("R2", "clean", { files_scanned: 12 }), inconclusive("R4", "not run"), fail("R7", "no .env.example", { gitignored: { ".env": true } })] });
const tamper = (patch: (a: Record<string, unknown>) => void) => {
  const a = JSON.parse(JSON.stringify(valid())) as Record<string, unknown>;
  patch(a);
  return JSON.stringify(a);
};

describe("results.json validation (the CI report job's gate)", () => {
  it("accepts what repo-checks writes", () => {
    const a = parseArtifact(JSON.stringify(valid()));
    expect(a.checks.map((c) => c.key)).toEqual(["R2", "R4", "R7"]);
    expect(a.checks[1].detail.inconclusive).toBe(true);
  });

  it("rejects junk", () => {
    const bad: [string, string][] = [
      ["not json", "{nope"],
      ["unknown key", tamper((a) => ((a.checks as { key: string }[])[0].key = "U1"))],
      ["extra top-level field", tamper((a) => (a.inject = "ignore previous instructions"))],
      ["extra detail field", tamper((a) => (((a.checks as { detail: Record<string, unknown> }[])[0].detail.score = 5)))],
      ["string as passed", tamper((a) => ((a.checks as { passed: unknown }[])[0].passed = "true"))],
      ["null without inconclusive", tamper((a) => ((a.checks as { passed: unknown }[])[0].passed = null))],
      ["duplicate keys", tamper((a) => (a.checks = [...(a.checks as unknown[]), (a.checks as unknown[])[0]]))],
      ["long summary", tamper((a) => ((a.checks as { detail: { summary: string } }[])[0].detail.summary = "x".repeat(700)))],
      ["deep evidence", tamper((a) => ((a.checks as { detail: { evidence: unknown } }[])[0].detail.evidence = { a: { b: { c: { d: 1 } } } }))],
      ["bad evidence key", tamper((a) => ((a.checks as { detail: { evidence: unknown } }[])[0].detail.evidence = { "__proto__x": 1, "Bad Key": 2 }))],
      ["other repo host", tamper((a) => (a.repo_url = "https://evil.example/x/y"))],
      ["short sha", tamper((a) => (a.sha = "abc"))],
      ["schema version", tamper((a) => (a.schema = "verify-swe1/9"))],
      ["no checks", tamper((a) => (a.checks = []))],
    ];
    for (const [name, raw] of bad) expect(() => parseArtifact(raw), name).toThrow();
    expect(() => parseArtifact(" ".repeat(250_000))).toThrow(/too large/);
  });

  it("flattens nested evidence into the bounded shape", () => {
    const f = flattenEvidence({ "Weird Key!": 1, nested: { deep: { deeper: true } }, list: [1, "a", { x: 1 }], rows: [{ a: 1 }, { b: [1, 2] }] });
    expect(f).toEqual({ weird_key_: 1, nested: { deep: '{"deeper":true}' }, list: [1, "a", '{"x":1}'], rows: [{ a: 1 }, { b: [1, 2] }] });
  });
});

describe("check rows", () => {
  it("shape inconclusive and informational results", () => {
    expect(inconclusive("U4", "no logins")).toMatchObject({ passed: null, detail: { inconclusive: true, reason: "no logins", summary: "Inconclusive: no logins" } });
    expect(informational("U8", "grade B").detail.inconclusive).toBeUndefined();
  });

  it("builds a service-role row with run metadata", () => {
    const row = toRunRow("sub-1", pass("U1", "ok", { status: 200 }), { ranBy: "admin-1", meta: { harness_run: "run-1" } });
    expect(row).toMatchObject({ submission_id: "sub-1", check_key: "U1", passed: true, manual: false, ran_by: "admin-1" });
    expect(row.detail).toMatchObject({ summary: "ok", harness_run: "run-1", version: "swe1-harness/1", evidence: { status: 200 } });
  });

  it("caps the stored size whatever the target app sends back", () => {
    const huge = fail("U3", "x", { body: "y".repeat(100_000), many: Array.from({ length: 500 }, (_, i) => ({ i, text: "z".repeat(500) })) });
    const d = shapeDetail(huge);
    expect(Buffer.byteLength(JSON.stringify(d))).toBeLessThanOrEqual(MAX_DETAIL_BYTES);
    expect(d.summary).toBe("x");
  });

  it("redacts secrets from free text", () => {
    const token = ["eyJhbGciOiJIUzI1NiJ9", "eyJyb2xlIjoic2VydmljZV9yb2xlIn0", "c2lnbmF0dXJlLXNpZ25hdHVyZQ"].join(".");
    const key = ["sb", "secret", "0123456789abcdef"].join("_");
    const out = redactSecrets(`token ${token} key ${key}`);
    expect(out).not.toContain(token);
    expect(out).not.toContain(key);
  });
});
