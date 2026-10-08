import { describe, expect, it } from "vitest";
import { extractCustomerLinks, extractPageLinks, extractScriptUrls } from "@/lib/harness/bundle";
import { parseLoginForms } from "@/lib/harness/app-login";
import { fail, holdBackInconclusive, inconclusive, informational, latestByKey, pass, type StoredRun } from "@/lib/harness/checks";
import { elements, startTags, stripComments } from "@/lib/harness/html-scan";
import { redirectHeaders } from "@/lib/harness/http";
import { findJwts, jwtCandidates } from "@/lib/harness/jwt";
import { analyseMigrations, r1Verdict, rotationDocumented, type GitleaksFinding } from "@/lib/harness/repo-rules";
import { templatesFromPage } from "@/lib/harness/url-checks";

/** Regression tests for the harness review findings (false passes, overwritten results, hostile input). */

const b64url = (s: string) => Buffer.from(s).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}.c2lnbmF0dXJlc2lnbmF0dXJl`;

describe("R1: what counts as a documented key rotation", () => {
  it.each([
    "Key rotation is out of scope for this submission.",
    "The leaked OpenRouter key was never rotated.",
    "I ran out of time, so the secrets were not rotated.",
    "Rotating the keys is left as a follow-up.",
    "No credentials were revoked.",
    "We should rotate the key at some point.",
    "The service key will be rotated after the demo.",
    "I asked the client to rotate the key.",
    "I didn't rotate the OPENROUTER_API_KEY.",
  ])("not documented: %s", (text) => {
    const r = rotationDocumented(text);
    expect(r.documented).toBe(false);
    expect(r.status).toBe("negated");
  });

  it.each([
    "## Security\nThe OpenRouter key from the old .env.local was rotated on 7 Oct.",
    "- **F13**: rotated the `OPENROUTER_API_KEY` and the Supabase secret key on 8 Oct",
    "No secrets remain in the repo; the leaked key was rotated.",
    "The old key will no longer work because it was revoked.",
  ])("documented: %s", (text) => {
    expect(rotationDocumented(text)).toMatchObject({ documented: true, status: "documented" });
  });

  it("a mention without saying it was done is unclear; a heading alone is nothing", () => {
    expect(rotationDocumented("Key rotation: see the Supabase dashboard")).toMatchObject({ status: "unclear" });
    expect(rotationDocumented("## Key rotation\n\nSee below.")).toMatchObject({ status: "none" });
  });
});

describe("R1 verdict", () => {
  const finding: GitleaksFinding = { rule: "generic-api-key", file: ".env.local", commit: "abc123", line: 1 };
  const rot = (status: "documented" | "unclear" | "negated" | "none") => ({ status, quote: status === "none" ? null : "the quote" });

  it("a secret still in the graded commit fails even with a documented rotation", () => {
    const r = r1Verdict({ history: [finding], present: [".env.production"], presentVia: "gitleaks over the checked-out commit", rotation: rot("documented") });
    expect(r.passed).toBe(false);
    expect(r.detail.summary).toMatch(/still in the graded commit/);
  });

  it("history only: documented passes (with a note), unclear is inconclusive, negated or none fails", () => {
    const base = { history: [finding], present: [], presentVia: "gitleaks over the checked-out commit" };
    expect(r1Verdict({ ...base, rotation: rot("documented") })).toMatchObject({ passed: true, detail: { reviewer_note: expect.stringMatching(/rotated but not rewritten/) } });
    expect(r1Verdict({ ...base, rotation: rot("unclear") })).toMatchObject({ passed: null, detail: { inconclusive: true } });
    expect(r1Verdict({ ...base, rotation: rot("negated") })).toMatchObject({ passed: false, detail: { summary: expect.stringMatching(/it says/) } });
    expect(r1Verdict({ ...base, rotation: rot("none") }).passed).toBe(false);
    expect(r1Verdict({ ...base, history: [], rotation: rot("none") }).passed).toBe(true);
  });

  it("without gitleaks a documented rotation is for a reviewer, never a pass", () => {
    const base = { history: null, present: [], presentVia: ".env files", envHistory: { files: [".env.local"], secretLines: 1 }, gitleaksProblem: "gitleaks is not available" };
    expect(r1Verdict({ ...base, rotation: rot("documented") }).passed).toBeNull();
    expect(r1Verdict({ ...base, rotation: rot("none") }).passed).toBe(false);
    expect(r1Verdict({ ...base, envHistory: { files: [], secretLines: 0 }, rotation: rot("none") }).passed).toBeNull();
  });
});

describe("R3: migrations the Supabase CLI never applies", () => {
  it("lists files not named <digits>_<name>.sql", () => {
    const a = analyseMigrations([
      { path: "supabase/migrations/schema.sql", content: "create table public.customers (id int); alter table public.customers enable row level security;" },
      { path: "supabase/migrations/20261001000001_init.sql", content: "create table public.lines (id int); alter table public.lines enable row level security;" },
    ]);
    expect(a.notApplied).toEqual(["supabase/migrations/schema.sql"]);
  });
});

describe("an inconclusive re-run never hides an earlier result", () => {
  const row = (check_key: string, passed: boolean | null, manual = false, detail: Record<string, unknown> = {}): StoredRun => ({ check_key, passed, manual, detail });

  it("holds back inconclusive results over pass/fail, manual and informational rows; writes the rest", () => {
    const latest = latestByKey([
      row("U5", true, true, { summary: "429 after 30 requests, checked by hand" }), // newest first
      row("U5", null, false, { inconclusive: true }),
      row("M1", false),
      row("U8", null, false, { summary: "grade B" }),
      row("U2", null, false, { inconclusive: true }),
    ]);
    const results = [inconclusive("U5", "no 429"), inconclusive("M1", "manager could not sign in"), inconclusive("U8", "scan failed"), inconclusive("U2", "still no sign-in"), inconclusive("U3", "no key"), pass("M1", "ok"), fail("U5", "no limit"), informational("U8", "grade A")];
    const { write, kept } = holdBackInconclusive(results, latest);
    expect(kept.map((k) => k.key)).toEqual(["U5", "M1", "U8"]);
    expect(kept[0].reason).toBe("no 429");
    expect(write.map((r) => `${r.key}:${r.passed}`)).toEqual(["U2:null", "U3:null", "M1:true", "U5:false", "U8:null"]);
  });
});

describe("redirects", () => {
  it("drop the session, token and key on a cross-origin hop, and the body headers on every hop", () => {
    const h = { cookie: "sb-x-auth-token=secret", authorization: "Bearer t", apikey: "k", accept: "text/html", "content-type": "application/json" };
    const a = new URL("https://desk.example.co.za/queue");
    expect(redirectHeaders(h, a, new URL("https://desk.example.co.za/login"))).toEqual({ cookie: "sb-x-auth-token=secret", authorization: "Bearer t", apikey: "k", accept: "text/html" });
    expect(redirectHeaders(h, a, new URL("https://vercel.com/sso?next=/queue"))).toEqual({ accept: "text/html" });
  });
});

describe("page parsing is linear on hostile pages", () => {
  const base = new URL("https://desk.example.co.za/");
  const time = (fn: () => unknown) => {
    const t = Date.now();
    fn();
    return Date.now() - t;
  };

  it("reads well-formed pages as before", () => {
    const html = `<a href="/customers/1">Ubuntu <b>Logistics</b></a><a href="#x">x</a><a href=/queue>Queue</a><script src="/_next/static/chunks/a.js"></script><link rel="modulepreload" href="/_next/static/chunks/b.js"><link rel="preload" as="style" href="/c.js">`;
    expect(extractCustomerLinks(html, base)).toEqual([{ url: "https://desk.example.co.za/customers/1", id: "1", text: "Ubuntu Logistics" }]);
    expect(extractPageLinks(html, base)).toEqual(["https://desk.example.co.za/customers/1", "https://desk.example.co.za/queue"]);
    expect(extractScriptUrls(html, base).sort()).toEqual(["https://desk.example.co.za/_next/static/chunks/a.js", "https://desk.example.co.za/_next/static/chunks/b.js"]);
    expect(elements("<form a><form b>x</form>y</form>", "form").map((e) => e.inner)).toEqual(["<form b>x"]);
    expect(startTags("<a href=1><abbr><A HREF=2>", ["a"]).map((t) => t.raw)).toEqual(["<a href=1>", "<A HREF=2>"]);
    expect(stripComments("a<!-- x -->b<!-- open")).toBe("ab");
  });

  it("handles 2 MB of unclosed tags in well under a second", () => {
    const unclosedLinks = '<a href="/customers/1">'.repeat(90_000); // ~2 MB, no </a>
    const unclosedForms = "<form><input type=password name=p>".repeat(60_000);
    const unclosedSelects = "<select name=template><option value=1>utility".repeat(45_000);
    const openTags = "<a <a <a ".repeat(230_000); // no ">" anywhere
    for (const [label, ms] of [
      ["links", time(() => extractCustomerLinks(unclosedLinks, base))],
      ["page links", time(() => extractPageLinks(openTags, base))],
      ["scripts", time(() => extractScriptUrls(openTags + "/_next/static/".repeat(100_000), base))],
      ["forms", time(() => parseLoginForms(unclosedForms, "https://desk.example.co.za/login"))],
      ["templates", time(() => templatesFromPage(unclosedSelects))],
    ] as const) {
      expect({ label, fast: ms < 1500 }).toEqual({ label, fast: true });
    }
  });

  it("finds JWTs in linear time, and still finds a real one after junk", () => {
    const service = jwt({ role: "service_role", ref: "abc" });
    const junk = "eyJ".repeat(700_000); // 2.1 MB of "eyJeyJ…" without a dot
    let found: ReturnType<typeof findJwts> = [];
    const ms = time(() => (found = findJwts(`${junk} x=${JSON.stringify(service)} ${"eyJabcdefgh.eyJabcdefgh.x ".repeat(2000)}`)));
    expect(ms).toBeLessThan(1500);
    expect(found.some((j) => j.role === "service_role")).toBe(true);
    expect(jwtCandidates(`a.${service}.b`)).toContain(service.split(".").slice(0, 2).join(".") + "." + service.split(".")[2]);
  });
});
