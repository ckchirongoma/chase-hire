import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Server actions run as whichever client h.client holds.
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));

import { batchAdvance } from "@/app/admin/pipeline/actions";
import { overrideGrade } from "@/app/admin/grading/actions";
import { respondToReview } from "@/app/admin/reviews/actions";
import { GET as sweep } from "@/app/api/cron/sweep/route";
import { computeScores, refreshScores } from "@/lib/server/scores";
import { finalComposite, liveComposite, preLiveComposite } from "@/lib/scoring/composite";
import { anon, consent, fakeFinishedAttempt, fakeParsedCv, makeAdmin, newUser, psql, service } from "../helpers/local";

const admin = service();
const SWE = "software-engineer";
const BA = "business-analyst";
const REASON = "Composite above 70 with every stage graded and no open flags.";

let boss: Awaited<ReturnType<typeof newUser>>;
beforeAll(async () => {
  boss = await newUser("pipeline-admin");
  await makeAdmin(boss.id);
});

async function applicant(tag: string, role = SWE) {
  const u = await newUser(tag);
  await consent(u.client);
  await fakeParsedCv(u.id);
  await fakeFinishedAttempt(u.id, 4); // percentile 30
  const { data, error } = await u.client.rpc("apply_to_role", { p_slug: role });
  if (error) throw error;
  return { ...u, appId: data as string };
}

/** Test setup only: writes stage results directly (triggers off for this session). */
function seed(sql: string) {
  psql(`set session_replication_role = replica; ${sql}`);
}

function setStage(appId: string, stage: string, status: string) {
  seed(`update public.applications set stage = '${stage}', status = '${status}' where id = '${appId}';`);
}

/** Interview, quiz and both work submissions with the given scores. Returns the subject ids. */
async function seedStages(u: { id: string; appId: string }, role: string, s: { interview: number; quiz: number; work1: number; work2: number }) {
  const session = randomUUID();
  const sub1 = randomUUID();
  const sub2 = randomUUID();
  const { data: stages } = await admin.from("work_stages").select("id, app_stage, key").eq("role_slug", role);
  const st = Object.fromEntries((stages ?? []).map((x) => [x.app_stage, x]));
  const a1 = randomUUID();
  const a2 = randomUUID();
  seed(`
    insert into public.interview_sessions (id, application_id, user_id, plan, started_at, deadline_at, ended_at, end_reason, score, summary)
      values ('${session}', '${u.appId}', '${u.id}', '{}', now() - interval '40 minutes', now() - interval '5 minutes', now() - interval '6 minutes', 'completed', ${s.interview}, '{}');
    insert into public.quiz_attempts (application_id, user_id, seed, started_at, deadline_at, submitted_at, raw_score, pct)
      values ('${u.appId}', '${u.id}', 1, now() - interval '30 minutes', now() - interval '18 minutes', now() - interval '19 minutes', 10, ${s.quiz});
    insert into public.work_attempts (id, application_id, stage_id, user_id, open_until, started_at, submitted_at)
      values ('${a1}', '${u.appId}', '${st.work_1.id}', '${u.id}', now(), now() - interval '2 days', now() - interval '1 day'),
             ('${a2}', '${u.appId}', '${st.work_2.id}', '${u.id}', now(), now() - interval '1 day', now() - interval '1 hour');
    insert into public.submissions (id, attempt_id, user_id, stage_key, score, grading_status)
      values ('${sub1}', '${a1}', '${u.id}', '${st.work_1.key}', ${s.work1}, 'done'),
             ('${sub2}', '${a2}', '${u.id}', '${st.work_2.key}', ${s.work2}, 'done');
  `);
  return { session, sub1, sub2 };
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
/** Runs a server action and returns where it sent the browser ("404" for notFound). */
async function outcome(action: Promise<unknown>): Promise<URL | "404"> {
  try {
    await action;
  } catch (err) {
    const digest = String((err as { digest?: unknown }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT;")) return new URL(digest.split(";").slice(2, -2).join(";"), "http://localhost");
    if (digest === "NEXT_HTTP_ERROR_FALLBACK;404") return "404";
    throw err;
  }
  throw new Error("the action returned without redirecting");
}
const msg = (r: URL | "404", key: "error" | "ok") => (r === "404" ? "404" : r.searchParams.get(key));

describe("composite scores (docs/09 §2)", () => {
  it("weights each stage, combines the live stage 50/50, flags, and persists the result", async () => {
    const u = await applicant("composite");
    const { session } = await seedStages(u, SWE, { interview: 60, quiz: 70, work1: 50, work2: 90 });
    const r1 = await newUser("rater1");
    const r2 = await newUser("rater2");
    seed(`
      insert into public.live_scorecards (application_id, kind, rater, total, submitted_at) values
        ('${u.appId}', 'panel_interview', '${r1.id}', 80, now()),
        ('${u.appId}', 'panel_interview', '${r2.id}', 60, now()),
        ('${u.appId}', 'panel_interview', '${boss.id}', 0, null),
        ('${u.appId}', 'live_defence', '${r1.id}', 50, now()),
        ('${u.appId}', 'exec_scenario', '${r1.id}', 90, now());
      insert into public.grade_summaries (subject_type, subject_id, rubric_id, criterion_key, weight, median_score, final_score)
        select 'interview', '${session}', id, 'communication', 1, 4, 4 from public.rubrics where key = 'interview' and active;
      insert into public.review_requests (user_id, application_id, stage, message) values ('${u.id}', '${u.appId}', 'quiz', 'Please re-check question 7.');
    `);

    const [s] = await computeScores(admin, { applicationIds: [u.appId] });
    const pre = preLiveComposite(SWE, { reasoning: 30, interview: 60, quiz: 70, work_1: 50, work_2: 90 });
    const live = liveComposite(SWE, { panel_interview: 70, live_defence: 50, exec_scenario: 90 });
    expect(s.parts).toEqual({ reasoning: 30, interview: 60, quiz: 70, work_1: 50, work_2: 90 });
    expect(s.preLive).toEqual(pre);
    expect(s.preLive).toMatchObject({ score: 62.5, coverage: 1 });
    expect(s.live).toEqual(live);
    expect(s.final).toBe(finalComposite(pre, live));
    expect(s.execComms).toEqual({ score: 75, n: 1 });
    expect(s.flags).toMatchObject({ openReviewRequests: 1, lockedSessions: 0, gradesNeedingReview: 0 });

    expect(await refreshScores(admin, [u.appId])).toBe(1);
    const { data: app } = await admin.from("applications").select("composite_score, final_score").eq("id", u.appId).single();
    expect(Number(app!.composite_score)).toBe(62.5);
    expect(Number(app!.final_score)).toBe(s.final);
    expect(await refreshScores(admin, [u.appId])).toBe(0); // unchanged → no write
  });

  it("is partial (with coverage) mid-pipeline and null before any stage", async () => {
    const u = await applicant("partial", BA);
    const [s] = await computeScores(admin, { applicationIds: [u.appId] });
    expect(s.preLive).toEqual({ score: 30, coverage: 0.1, missing: ["interview", "quiz", "work_1", "work_2"] });
    expect(s.final).toBeNull();
  });

  it("the cron sweep refreshes stored composites", async () => {
    const u = await applicant("sweep-score");
    seed(`update public.applications set composite_score = null where id = '${u.appId}';`);
    process.env.CRON_SECRET ??= "test-cron-secret-123456";
    const res = await sweep(new Request("http://localhost/api/cron/sweep", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    expect(res.status).toBe(200);
    expect((await res.json()).scoresUpdated).toBeGreaterThanOrEqual(1);
    const { data } = await admin.from("applications").select("composite_score").eq("id", u.appId).single();
    expect(Number(data!.composite_score)).toBe(30);
  });
});

describe("batch advance", () => {
  it("advances only confirmed, eligible candidates with one reason on each decision", async () => {
    const a = await applicant("batch-a");
    const b = await applicant("batch-b");
    const busy = await applicant("batch-busy");
    await seedStages(a, SWE, { interview: 80, quiz: 80, work1: 80, work2: 80 });
    await seedStages(b, SWE, { interview: 70, quiz: 70, work1: 70, work2: 70 });
    setStage(a.appId, "work_2", "awaiting_review");
    setStage(b.appId, "work_2", "submitted");
    setStage(busy.appId, "quiz", "in_progress");
    h.client = boss.client;

    // Not an admin → 404.
    h.client = a.client;
    expect(await outcome(batchAdvance(form({ ids: a.appId, confirm: "1", reason: REASON })))).toBe("404");
    h.client = boss.client;

    // The typed count must match, the reason must be real, and everyone must be waiting for review.
    expect(msg(await outcome(batchAdvance(form({ ids: `${a.appId},${b.appId}`, confirm: "1", reason: REASON }))), "error")).toMatch(/exact number of candidates \(2\)/);
    expect(msg(await outcome(batchAdvance(form({ ids: a.appId, confirm: "1", reason: "ok" }))), "error")).toMatch(/at least 20/);
    expect(msg(await outcome(batchAdvance(form({ ids: "", confirm: "0", reason: REASON }))), "error")).toMatch(/at least one/);
    expect(msg(await outcome(batchAdvance(form({ ids: `${a.appId},${busy.appId}`, confirm: "2", reason: REASON }))), "error")).toMatch(/1 selected application/);
    const { data: untouched } = await admin.from("decisions").select("id").in("application_id", [a.appId, b.appId, busy.appId]);
    expect(untouched).toEqual([]);

    const done = await outcome(batchAdvance(form({ ids: `${a.appId},${b.appId},${a.appId}`, confirm: "2", reason: REASON, back: "/admin/pipeline?role=software-engineer" })));
    expect(done !== "404" && done.pathname).toBe("/admin/pipeline");
    expect(msg(done, "ok")).toBe("Advanced 2 candidates.");
    expect(done !== "404" && done.searchParams.get("role")).toBe(SWE);

    const { data: apps } = await admin.from("applications").select("id, stage, status").in("id", [a.appId, b.appId]);
    expect(apps!.every((x) => x.stage === "shortlist" && x.status === "advanced")).toBe(true);
    const { data: decisions } = await admin.from("decisions").select("application_id, decision, reason, decided_by, scores_snapshot").in("application_id", [a.appId, b.appId]);
    expect(decisions).toHaveLength(2);
    for (const d of decisions!) {
      expect(d).toMatchObject({ decision: "advance", reason: REASON, decided_by: boss.id });
      // The snapshot carries the composite refreshed just before deciding.
      expect(Number(d.scores_snapshot.application.composite_score)).toBeGreaterThan(0);
    }
  });

  it("the batch RPC is admin-only and capped at 200", async () => {
    const u = await newUser("batch-rpc");
    const bad = await u.client.rpc("admin_batch_advance", { p_application_ids: [randomUUID()], p_reason: REASON });
    expect(bad.error?.message).toMatch(/admin_only/);
    const anonRes = await anon().rpc("admin_batch_advance", { p_application_ids: [randomUUID()], p_reason: REASON });
    expect(anonRes.error).not.toBeNull();
    const big = await boss.client.rpc("admin_batch_advance", { p_application_ids: Array.from({ length: 201 }, () => randomUUID()), p_reason: REASON });
    expect(big.error?.message).toMatch(/batch_size_invalid/);
  });
});

describe("grading queue override", () => {
  it("stores the human score with a reason, rescoring the stage and the composite", async () => {
    const u = await applicant("override");
    const { session } = await seedStages(u, SWE, { interview: 40, quiz: 50, work1: 50, work2: 50 });
    seed(`
      insert into public.grade_summaries (subject_type, subject_id, rubric_id, criterion_key, weight, median_score, spread, needs_human_review, review_reason)
        select 'interview', '${session}', id, 'specificity', 1, 2, 3, true, 'samples disagree by 3 points' from public.rubrics where key = 'interview' and active;
    `);
    await refreshScores(admin, [u.appId]);
    const before = (await computeScores(admin, { applicationIds: [u.appId] }))[0];
    expect(before.flags.gradesNeedingReview).toBe(1);

    const base = { subject_type: "interview", subject_id: session, criterion_key: "specificity" };
    h.client = u.client;
    expect(await outcome(overrideGrade(form({ ...base, score: "5", reason: "Quoted a precise index design and the 40→6 minute timing." })))).toBe("404");
    h.client = boss.client;
    expect(msg(await outcome(overrideGrade(form({ ...base, score: "5", reason: "short" }))), "error")).toMatch(/at least 20/);
    expect(msg(await outcome(overrideGrade(form({ ...base, score: "7", reason: "Quoted a precise index design and timings." }))), "error")).toMatch(/1 to 5/);
    expect(msg(await outcome(overrideGrade(form({ ...base, criterion_key: "nope", score: "5", reason: "Quoted a precise index design and timings." }))), "error")).toMatch(/not found/);

    const ok = await outcome(overrideGrade(form({ ...base, score: "5", reason: "Quoted a precise index design and the 40→6 minute timing." })));
    expect(msg(ok, "ok")).toMatch(/specificity/);
    const { data: g } = await admin.from("grade_summaries").select("human_score, human_by, final_score, needs_human_review").eq("subject_id", session).eq("criterion_key", "specificity").single();
    expect(g).toMatchObject({ human_by: boss.id });
    expect(Number(g!.human_score)).toBe(5);
    expect(Number(g!.final_score)).toBe(5);

    // The DB trigger rescored the session; the stored composite followed.
    const { data: sess } = await admin.from("interview_sessions").select("score").eq("id", session).single();
    expect(Number(sess!.score)).toBe(100);
    const after = (await computeScores(admin, { applicationIds: [u.appId] }))[0];
    expect(after.parts.interview).toBe(100);
    expect(after.flags.gradesNeedingReview).toBe(0);
    const { data: app } = await admin.from("applications").select("composite_score").eq("id", u.appId).single();
    expect(Number(app!.composite_score)).toBe(after.preLive.score);
  });
});

describe("review requests queue", () => {
  it("lets an admin reply (and close); the candidate sees the reply", async () => {
    const u = await applicant("review-q");
    const { data: rr, error } = await u.client.from("review_requests").insert({ application_id: u.appId, stage: "interview", message: "I can't use a microphone; may I type?" }).select("id").single();
    expect(error).toBeNull();

    h.client = u.client;
    expect(await outcome(respondToReview(form({ review_id: rr!.id, response: "Yes" })))).toBe("404");
    h.client = boss.client;
    expect(msg(await outcome(respondToReview(form({ review_id: rr!.id, response: "ok" }))), "error")).toMatch(/reply/);
    expect(msg(await outcome(respondToReview(form({ review_id: randomUUID(), response: "We have set up a typed interview." }))), "error")).toMatch(/not found/);
    const r = await outcome(respondToReview(form({ review_id: rr!.id, response: "We have set up a typed interview for you.", close: "1" })));
    expect(r !== "404" && r.searchParams.get("ok")).toBe("1");

    const { data: mine } = await u.client.from("review_requests").select("status, response, responded_by").eq("id", rr!.id).single();
    expect(mine).toEqual({ status: "closed", response: "We have set up a typed interview for you.", responded_by: boss.id });
  });
});
