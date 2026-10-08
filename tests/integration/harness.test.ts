import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildArtifact } from "@/lib/harness/artifact";
import { fail, inconclusive, pass, type CheckKey } from "@/lib/harness/checks";
import { HarnessError, recordManualResult, runImportHarness, runUrlHarness } from "@/lib/server/harness";
import { fixtureExpected, fixtureFiles, startFakeTarget, type FakeTarget } from "../harness-fixtures/fake-target";
import { consent, fakeFinishedAttempt, fakeParsedCv, LOCAL, makeAdmin, newUser, psql, service } from "../helpers/local";

/**
 * The SWE Test 1 verification harness against two fake deployments (tests/harness-fixtures):
 * a hardened "good" app must pass every URL, import and data check, and the planted-fault
 * "bad" app must fail each of them. Results land in the platform's verification_runs.
 */

const exec = promisify(execFile);
const admin = service();
const BUNDLE = `test-harness-${Date.now()}/bundle_c`;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = "https://github.com/example-candidate/kopano-renewal-desk";
let boss: Awaited<ReturnType<typeof newUser>>;
let good: FakeTarget;
let bad: FakeTarget;
let goodSub: string;
let badSub: string;
let stageId: string;

function ensureStage() {
  psql(`insert into public.work_stages (role_slug, key, app_stage, title, brief_md, intended_effort, work_window, dataset_bundle, rubric_key) values
    ('software-engineer', 'swe_test1', 'work_1', 'SWE Test 1', 'Harden and ship the renewal desk.', 'about 6 hours', interval '72 hours', 'v1/bundle_c', 'swe_test1')
    on conflict (key) do nothing;`);
}

async function swe1Submission(target: FakeTarget, testLogins = target.testLogins): Promise<string> {
  const u = await newUser("harness");
  await consent(u.client);
  await fakeParsedCv(u.id);
  await fakeFinishedAttempt(u.id, 4);
  const { data: appId, error } = await u.client.rpc("apply_to_role", { p_slug: "software-engineer" });
  if (error) throw error;
  psql(`alter table public.applications disable trigger applications_status_guard;
        update public.applications set stage = 'work_1', status = 'submitted' where id = '${appId}';
        alter table public.applications enable trigger applications_status_guard;`);
  const { data: attempt, error: aErr } = await admin.from("work_attempts").insert({ application_id: appId, stage_id: stageId, user_id: u.id }).select("id").single();
  if (aErr) throw aErr;
  await admin.from("work_attempts").update({ started_at: new Date().toISOString() }).eq("id", attempt.id);
  const { data: sub, error: sErr } = await admin
    .from("submissions")
    .insert({ attempt_id: attempt.id, user_id: u.id, stage_key: "swe_test1", repo_url: REPO, repo_commit_sha: SHA, deployed_url: target.appUrl, test_logins: testLogins })
    .select("id")
    .single();
  if (sErr) throw sErr;
  return sub.id as string;
}

async function latest(subId: string): Promise<Map<string, { passed: boolean | null; detail: Record<string, unknown>; manual: boolean; ran_by: string | null }>> {
  const { data, error } = await admin.from("verification_runs").select("check_key, passed, detail, manual, ran_by, ran_at").eq("submission_id", subId).order("ran_at", { ascending: false });
  if (error) throw error;
  const m = new Map();
  for (const r of data ?? []) if (!m.has(r.check_key)) m.set(r.check_key, r);
  return m;
}

const opts = () => ({ ranBy: boss.id, bundlePrefix: BUNDLE, budgetMs: 120_000, observatoryUrl: undefined as string | undefined, settlePollMs: 100 });

beforeAll(async () => {
  process.env.SNAPSHOT_ALLOW_PRIVATE = "1";
  ensureStage();
  stageId = psql("select id from public.work_stages where key = 'swe_test1'").trim();
  boss = await newUser("harness-admin");
  await makeAdmin(boss.id);
  const files = fixtureFiles();
  for (const [name, body, type] of [
    ["expected_month2.json", Buffer.from(JSON.stringify(fixtureExpected())), "application/json"],
    ["base_month2.xlsx", files.month2, "application/octet-stream"],
    ["base_month2_drift.xlsx", files.drift, "application/octet-stream"],
  ] as const) {
    const { error } = await admin.storage.from("datasets").upload(`${BUNDLE}/internal/${name}`, body, { contentType: type, upsert: true });
    if (error) throw error;
  }
  [good, bad] = await Promise.all([startFakeTarget("good"), startFakeTarget("bad")]);
  [goodSub, badSub] = await Promise.all([swe1Submission(good), swe1Submission(bad)]);
}, 60_000);

afterAll(async () => {
  await Promise.all([good?.close(), bad?.close()]);
  await admin.storage.from("datasets").remove(["expected_month2.json", "base_month2.xlsx", "base_month2_drift.xlsx"].map((f) => `${BUNDLE}/internal/${f}`));
  delete process.env.SNAPSHOT_ALLOW_PRIVATE;
});

const U: CheckKey[] = ["U1", "U2", "U3", "U4", "U5", "U6", "U7"];
const MD: CheckKey[] = ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "D-a", "D-b", "D-c"];

describe("URL checks U1–U8", () => {
  it("pass on the hardened app and store one row per check with evidence", async () => {
    const s = await runUrlHarness(admin, goodSub, { ...opts(), observatoryUrl: good.observatoryUrl });
    const rows = await latest(goodSub);
    for (const k of U) expect({ k, passed: rows.get(k)?.passed, summary: rows.get(k)?.detail.summary }).toMatchObject({ k, passed: true });
    expect(rows.get("U8")?.passed).toBeNull();
    expect(String(rows.get("U8")?.detail.summary)).toMatch(/grade B\+/);
    expect(s.passed.sort()).toEqual([...U].sort());
    // Rows carry who ran them, the run id and the harness version; never a password.
    const u1 = rows.get("U1")!;
    expect(u1.manual).toBe(false);
    expect(u1.ran_by).toBe(boss.id);
    expect(u1.detail.harness_run).toBe(s.runId);
    expect(JSON.stringify([...rows.values()])).not.toContain(good.users.a.password);
    // U5 stopped the authenticated burst at the first 429.
    expect((rows.get("U5")!.detail.evidence as Record<string, unknown>).first_429_at).toBeGreaterThan(0);
    const { data: run } = await admin.from("harness_runs").select("status, kind").eq("id", s.runId).single();
    expect(run).toMatchObject({ status: "done", kind: "url" });
  }, 120_000);

  it("fail on the planted-fault app", async () => {
    await runUrlHarness(admin, badSub, { ...opts(), observatoryUrl: bad.observatoryUrl });
    const rows = await latest(badSub);
    for (const k of U) expect({ k, passed: rows.get(k)?.passed, summary: rows.get(k)?.detail.summary }).toMatchObject({ k, passed: false });
    expect(String(rows.get("U2")!.detail.summary)).toMatch(/service_role/);
    // The unauthenticated burst stops early once the fault is proven (each success costs an LLM call).
    expect(bad.counters.summaryCalls).toBeLessThanOrEqual(15);
  }, 120_000);

  it("refuses to start a second run of the same kind while one is running", async () => {
    psql(`insert into public.harness_runs (submission_id, kind, status) values ('${goodSub}', 'url', 'running')`);
    await expect(runUrlHarness(admin, goodSub, opts())).rejects.toMatchObject({ status: 409 });
    psql(`update public.harness_runs set status = 'failed' where submission_id = '${goodSub}' and status = 'running'`);
  });

  it("records everything as inconclusive when the test logins are unusable", async () => {
    const sub = await swe1Submission(good, "Logins are in the README.");
    await runUrlHarness(admin, sub, { ...opts(), observatoryUrl: good.observatoryUrl });
    const rows = await latest(sub);
    for (const k of ["U4", "U6"]) {
      expect(rows.get(k)?.passed).toBeNull();
      expect(rows.get(k)?.detail.inconclusive).toBe(true);
    }
    expect(rows.get("U3")?.passed).toBe(true); // anonymous probes need no login
  }, 120_000);
});

describe("Month-2 import checks M1–M7 and data checks D-a..D-c", () => {
  it("pass on the hardened app", async () => {
    const s = await runImportHarness(admin, goodSub, opts());
    const rows = await latest(goodSub);
    for (const k of MD) expect({ k, passed: rows.get(k)?.passed, summary: rows.get(k)?.detail.summary }).toMatchObject({ k, passed: true });
    expect(s.skipped).toEqual([]);
    expect(good.counters.imports).toBe(3); // month 2, month 2 again, drift
    // Sentinel history was created as labelled probe rows.
    expect(good.db.interactions.some((i) => String(i.notes).startsWith("Verification harness probe (M2)"))).toBe(true);
  }, 120_000);

  it("skip M1–M5 on a second run (month 2 already imported) and keep the earlier rows", async () => {
    const before = await latest(goodSub);
    const s = await runImportHarness(admin, goodSub, opts());
    expect(s.skipped).toEqual(["M1", "M2", "M3", "M4", "M5"]);
    const after = await latest(goodSub);
    expect(after.get("M1")?.detail.harness_run).toBe(before.get("M1")?.detail.harness_run);
    expect(after.get("M6")?.passed).toBe(true);
    expect(after.get("M6")?.detail.harness_run).toBe(s.runId);
  }, 120_000);

  it("fail on the planted-fault app, judged after its background import settles", async () => {
    const s = await runImportHarness(admin, badSub, opts());
    const rows = await latest(badSub);
    for (const k of MD) expect({ k, passed: rows.get(k)?.passed, summary: rows.get(k)?.detail.summary }).toMatchObject({ k, passed: false });
    // "Import started": the harness waited for the data to stop changing before judging M1–M5.
    const { data: run } = await admin.from("harness_runs").select("summary").eq("id", s.runId).single();
    expect((run!.summary as { context: { month2_settle: unknown } }).context.month2_settle).toMatchObject({ settled: true, background: true });
    expect(String(rows.get("M2")!.detail.summary)).toMatch(/new IDs/);
    expect(String(rows.get("D-b")!.detail.summary)).toMatch(/After the month-2 import/);
  }, 120_000);

  it("refuses to run without the bundle files (a platform problem, so no rows)", async () => {
    await expect(runImportHarness(admin, goodSub, { ...opts(), bundlePrefix: "test-harness-missing/bundle_c" })).rejects.toBeInstanceOf(HarnessError);
  });
});

describe("apps that keep Supabase server-side (no publishable key in the bundle)", () => {
  let goodKeyless: FakeTarget;
  let badKeyless: FakeTarget;
  beforeAll(async () => {
    [goodKeyless, badKeyless] = await Promise.all([startFakeTarget("good", { keyInBundle: false }), startFakeTarget("bad", { keyInBundle: false })]);
  });
  afterAll(async () => {
    await Promise.all([goodKeyless?.close(), badKeyless?.close()]);
  });

  it("sign in through the login form and still catch the planted faults through the app", async () => {
    const sub = await swe1Submission(badKeyless);
    await runUrlHarness(admin, sub, { ...opts(), observatoryUrl: badKeyless.observatoryUrl });
    const rows = await latest(sub);
    // F04 ships only on a signed-in page: the form sign-in is what lets U2 see it.
    for (const k of ["U2", "U4", "U5", "U6", "U7"]) expect({ k, passed: rows.get(k)?.passed, summary: rows.get(k)?.detail.summary }).toMatchObject({ k, passed: false });
    expect((rows.get("U4")!.detail.evidence as Record<string, unknown>).signed_in_via).toBe("app-login-form");
    expect(rows.get("U3")).toMatchObject({ passed: null, detail: { inconclusive: true } });
    expect(String(rows.get("U3")!.detail.reason)).toMatch(/publishable/);
  }, 120_000);

  it("leave the database halves inconclusive on a hardened app, and pass once the candidate supplies the key", async () => {
    const sub = await swe1Submission(goodKeyless);
    await runUrlHarness(admin, sub, { ...opts(), observatoryUrl: goodKeyless.observatoryUrl });
    let rows = await latest(sub);
    for (const k of ["U1", "U2", "U5"]) expect({ k, passed: rows.get(k)?.passed, summary: rows.get(k)?.detail.summary }).toMatchObject({ k, passed: true });
    for (const k of ["U3", "U4", "U6", "U7"]) expect({ k, passed: rows.get(k)?.passed, inconclusive: rows.get(k)?.detail.inconclusive }).toMatchObject({ k, passed: null, inconclusive: true });
    expect(String(rows.get("U6")!.detail.reason)).toMatch(/refuses a call_back without a date .* database was not probed/);

    // Import checks count through REST: without the key they cannot run, and say why.
    await runImportHarness(admin, sub, opts());
    rows = await latest(sub);
    for (const k of MD) expect(rows.get(k)?.passed).toBeNull();
    expect(String(rows.get("M1")!.detail.reason)).toMatch(/publishable key/);

    // The candidate adds "supabase: <url> / <publishable key>" to the logins.
    const withKey = await swe1Submission(goodKeyless, `${goodKeyless.testLogins}\nsupabase: ${goodKeyless.supabaseUrl} / ${goodKeyless.publishableKey}\n`);
    await runUrlHarness(admin, withKey, { ...opts(), observatoryUrl: goodKeyless.observatoryUrl });
    rows = await latest(withKey);
    for (const k of U) expect({ k, passed: rows.get(k)?.passed, summary: rows.get(k)?.detail.summary }).toMatchObject({ k, passed: true });
  }, 180_000);
});

describe("Manual results and the CI report job", () => {
  it("admins record manual rows with their own session; candidates cannot", async () => {
    const { data: auth } = await boss.client.auth.getUser();
    await recordManualResult(boss.client, auth.user!, goodSub, { check_key: "R6", result: "pass", note: "CI green on the SHA, checked by hand" });
    const rows = await latest(goodSub);
    expect(rows.get("R6")).toMatchObject({ passed: true, manual: true, ran_by: boss.id });

    const stranger = await newUser("harness-stranger");
    const { error } = await stranger.client.from("verification_runs").insert({ submission_id: goodSub, check_key: "R1", passed: true, manual: true, ran_by: stranger.id, detail: {} });
    expect(error).not.toBeNull();
  });

  it("report.ts validates results.json and records R1–R7 for the submitted commit only", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-report-"));
    const file = path.join(dir, "results.json");
    const artifact = buildArtifact({
      repoUrl: REPO,
      sha: SHA,
      checks: [
        pass("R1", "gitleaks finds nothing", { findings: 0 }),
        pass("R2", "clean"),
        fail("R3", "Tables without RLS: customers", { without_rls: ["customers"] }),
        inconclusive("R4", "not run"),
        inconclusive("R5", "not run"),
        inconclusive("R6", "no token"),
        pass("R7", "env ignored"),
      ],
    });
    fs.writeFileSync(file, JSON.stringify(artifact));
    const env = { ...process.env, SUPABASE_URL: LOCAL.url, SUPABASE_SECRET_KEY: LOCAL.secret, VITEST: "" };
    const tsx = path.resolve("node_modules/.bin/tsx");
    const args = ["scripts/verify-swe1/report.ts", "--in", file, "--submission-id", badSub, "--repo-url", REPO, "--sha", SHA];
    await exec(tsx, args, { env });
    const rows = await latest(badSub);
    expect(rows.get("R3")).toMatchObject({ passed: false, manual: false });
    expect(rows.get("R1")?.detail.source).toBe("local");
    expect(rows.get("R4")?.detail.inconclusive).toBe(true);

    // Another commit (or repo) than the one frozen at submission is refused, and nothing is written.
    const other = args.map((a) => (a === SHA ? "f".repeat(40) : a));
    await expect(exec(tsx, other, { env })).rejects.toMatchObject({ stderr: expect.stringMatching(/not the submitted commit/) });
    // Junk in results.json is refused.
    fs.writeFileSync(file, JSON.stringify({ ...artifact, checks: [{ key: "U1", passed: true, detail: { summary: "x" } }] }));
    await expect(exec(tsx, args, { env })).rejects.toMatchObject({ stderr: expect.stringMatching(/failed validation/) });
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
