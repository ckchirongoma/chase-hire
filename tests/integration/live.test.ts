import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Server actions run as whichever client h.client holds.
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));

import { recordRetest, saveScorecard, updateLiveQuestion } from "@/app/admin/live/actions";
import { questionsFor, retestForm, scorecardCounts, viewerLiveGate, visibleScorecards } from "@/lib/server/live";
import { computeScores } from "@/lib/server/scores";
import { finalComposite, liveComposite, preLiveComposite } from "@/lib/scoring/composite";
import { kindsForRole, type ScoredKind } from "@/lib/live/scorecard";
import { livePercentile } from "@/lib/live/retest";
import { concernKey } from "@/lib/live/panel";
import { consent, fakeFinishedAttempt, fakeParsedCv, makeAdmin, newUser, psql, service } from "../helpers/local";

const admin = service();
const SWE = "software-engineer";
const BA = "business-analyst";
type User = Awaited<ReturnType<typeof newUser>>;

let raterA: User;
let raterB: User;
beforeAll(async () => {
  raterA = await newUser("live-rater-a");
  raterB = await newUser("live-rater-b");
  await makeAdmin(raterA.id);
  await makeAdmin(raterB.id);
});

/** Test setup only: writes stage results directly (triggers off for this session). */
function seed(sql: string) {
  psql(`set session_replication_role = replica; ${sql}`);
}

const CONCERNS = [
  { claim: "Led the Postgres migration for 2 million rows", reason: "Could not describe how the indexes were rebuilt" },
  { claim: "Cut report run time from 40 to 6 minutes", reason: "No numbers when probed on the baseline" },
  { claim: "Owned the CI pipeline", reason: "Described a colleague's work" },
];

/** A candidate at the live stage with every pre-live stage scored, and an AI interview summary. */
async function liveCandidate(tag: string, role: string, concerns: unknown[] = CONCERNS) {
  const u = await newUser(tag);
  await consent(u.client);
  await fakeParsedCv(u.id);
  await fakeFinishedAttempt(u.id, 4); // percentile 30
  const { data, error } = await u.client.rpc("apply_to_role", { p_slug: role });
  if (error) throw error;
  const appId = data as string;
  const { data: stages } = await admin.from("work_stages").select("id, app_stage, key").eq("role_slug", role);
  const st = Object.fromEntries((stages ?? []).map((x) => [x.app_stage, x]));
  const [a1, a2] = [randomUUID(), randomUUID()];
  const summary = JSON.stringify({ verification_concerns: concerns, live_followups: ["Ask how the index rebuild was tested.", "Ask for the baseline numbers.", "Ask who wrote the CI config."] }).replace(/'/g, "''");
  seed(`
    insert into public.interview_sessions (application_id, user_id, plan, started_at, deadline_at, ended_at, end_reason, score, summary)
      values ('${appId}', '${u.id}', '{}', now() - interval '40 minutes', now() - interval '5 minutes', now() - interval '6 minutes', 'completed', 60, '${summary}');
    insert into public.quiz_attempts (application_id, user_id, seed, started_at, deadline_at, submitted_at, raw_score, pct)
      values ('${appId}', '${u.id}', 1, now() - interval '30 minutes', now() - interval '18 minutes', now() - interval '19 minutes', 10, 70);
    insert into public.work_attempts (id, application_id, stage_id, user_id, open_until, started_at, submitted_at)
      values ('${a1}', '${appId}', '${st.work_1.id}', '${u.id}', now(), now() - interval '2 days', now() - interval '1 day'),
             ('${a2}', '${appId}', '${st.work_2.id}', '${u.id}', now(), now() - interval '1 day', now() - interval '1 hour');
    insert into public.submissions (attempt_id, user_id, stage_key, score, grading_status)
      values ('${a1}', '${u.id}', '${st.work_1.key}', 50, 'done'), ('${a2}', '${u.id}', '${st.work_2.key}', 90, 'done');
    update public.applications set stage = 'live', status = 'in_progress' where id = '${appId}';
  `);
  return { ...u, appId };
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

async function keysFor(role: string, appId: string, kind: ScoredKind) {
  const { byKind } = await questionsFor(admin, role, appId);
  return (byKind.get(kind) ?? []).map((q) => q.key);
}

/** Saves (or submits) a card where every question gets `score` (or per-key scores). */
async function score(rater: User, role: string, appId: string, kind: ScoredKind, value: number | Record<string, number>, intent: "draft" | "submit" = "submit") {
  h.client = rater.client;
  const keys = await keysFor(role, appId, kind);
  const fields: Record<string, string> = { application_id: appId, kind, intent, notes: `General notes for ${kind}` };
  for (const k of keys) {
    const v = typeof value === "number" ? value : value[k];
    if (v !== undefined) fields[`score:${k}`] = String(v);
    fields[`note:${k}`] = `Evidence for ${k}`;
  }
  return outcome(saveScorecard(form(fields)));
}

describe("panel question bank and verification concerns (docs/09 §5)", () => {
  it("seeds 6 panel questions per role (2 verification slots), 4 defence per role, 4 BA elicitation, 3 SWE exec, all anchored", async () => {
    const { data } = await admin.from("live_questions").select("role_slug, kind, key, probes, anchors, replaceable, active");
    const count = (role: string, kind: string) => data!.filter((q) => q.role_slug === role && q.kind === kind && q.active).length;
    expect([count(BA, "panel_interview"), count(SWE, "panel_interview")]).toEqual([6, 6]);
    expect([count(BA, "live_defence"), count(SWE, "live_defence")]).toEqual([4, 4]);
    expect(count(BA, "live_elicitation")).toBe(4);
    expect(count(SWE, "exec_scenario")).toBe(3);
    expect(data!.filter((q) => q.kind === "panel_interview" && q.replaceable).length).toBe(4);
    for (const q of data!) {
      for (const level of ["1", "3", "5"]) expect(String(q.anchors[level] ?? "").length).toBeGreaterThan(5);
      expect(q.probes.length).toBeGreaterThanOrEqual(2);
    }
    expect(data!.some((q) => q.key === "swe_defence_ai_off_debug")).toBe(true);
  });

  it("replaces the verification slots with the candidate's concerns: 2+ concerns, 1 concern, none", async () => {
    const two = await liveCandidate("live-concerns-2", SWE);
    const panel2 = (await questionsFor(admin, SWE, two.appId)).byKind.get("panel_interview")!;
    expect(panel2).toHaveLength(6);
    expect(panel2.filter((q) => q.source === "concern").map((q) => q.key)).toEqual([concernKey(CONCERNS[0].claim), concernKey(CONCERNS[1].claim)]);
    expect(panel2[4].text).toContain(CONCERNS[0].claim);
    expect(panel2[5].text).toContain(CONCERNS[1].claim);

    const one = await liveCandidate("live-concerns-1", BA, [CONCERNS[0]]);
    const panel1 = (await questionsFor(admin, BA, one.appId)).byKind.get("panel_interview")!;
    expect(panel1.map((q) => q.key)).toEqual(["ba_panel_data_problem", "ba_panel_hidden_need", "ba_panel_said_no", "ba_panel_spec_built", concernKey(CONCERNS[0].claim), "ba_panel_ai_checked"]);

    const none = await liveCandidate("live-concerns-0", BA, []);
    const q0 = await questionsFor(admin, BA, none.appId);
    expect(q0.byKind.get("panel_interview")!.every((q) => q.source === "bank")).toBe(true);
    expect(q0.kinds).toEqual(["panel_interview", "live_defence", "live_elicitation"]);
    expect(q0.byKind.get("live_elicitation")).toHaveLength(4);
  });
});

describe("independent raters (docs/09 §5)", () => {
  it("rater B can't see rater A's card until B submits; a submitted card is final", async () => {
    const c = await liveCandidate("live-independent", SWE);

    // A drafts, then submits. B sees nothing of A's card.
    expect(msg(await score(raterA, SWE, c.appId, "panel_interview", 3, "draft"), "ok")).toMatch(/Draft saved/);
    expect(await visibleScorecards(raterB.client, c.appId, raterB.id)).toEqual([]);
    expect(msg(await score(raterA, SWE, c.appId, "panel_interview", 4), "ok")).toMatch(/submitted/);
    expect((await visibleScorecards(raterB.client, c.appId, raterB.id)).filter((x) => x.rater === raterA.id)).toEqual([]);
    const { data: direct } = await raterB.client.from("live_scorecards").select("id").eq("application_id", c.appId);
    expect(direct).toEqual([]);
    // B may know that someone submitted (a count, no scores).
    expect((await scorecardCounts(admin, [c.appId], raterB.id)).get(c.appId)?.get("panel_interview")).toEqual({ submitted: 1, drafts: 0, mine: null });

    // A's stored card: every question 4 → 75, notes per question kept.
    const [mine] = await visibleScorecards(raterA.client, c.appId, raterA.id);
    expect(mine).toMatchObject({ kind: "panel_interview", rater: raterA.id, total: 75 });
    expect(mine.submitted_at).not.toBeNull();
    const k1 = concernKey(CONCERNS[0].claim);
    expect(Object.keys(mine.scores)).toContain(k1);
    expect(mine.notes).toContain(`[${k1}] Evidence for ${k1}`);

    // B drafts: still blind. B submits: now sees A's card (and A sees B's).
    expect(msg(await score(raterB, SWE, c.appId, "panel_interview", 2, "draft"), "ok")).toMatch(/Draft saved/);
    expect((await visibleScorecards(raterB.client, c.appId, raterB.id)).map((x) => x.rater)).toEqual([raterB.id]);
    expect(msg(await score(raterB, SWE, c.appId, "panel_interview", 2), "ok")).toMatch(/submitted/);
    expect((await visibleScorecards(raterB.client, c.appId, raterB.id)).map((x) => x.rater).sort()).toEqual([raterA.id, raterB.id].sort());
    expect((await visibleScorecards(raterA.client, c.appId, raterA.id)).map((x) => x.rater).sort()).toEqual([raterA.id, raterB.id].sort());
    // Seeing the panel interview doesn't reveal another part.
    expect(msg(await score(raterA, SWE, c.appId, "live_defence", 3), "ok")).toMatch(/submitted/);
    expect((await visibleScorecards(raterB.client, c.appId, raterB.id)).some((x) => x.kind === "live_defence")).toBe(false);

    // Final: the action refuses, and so does the database.
    expect(msg(await score(raterA, SWE, c.appId, "panel_interview", 5), "error")).toMatch(/submitted and final/);
    const { error } = await raterA.client.from("live_scorecards").update({ total: 100 }).eq("id", mine.id);
    expect(error?.message).toMatch(/scorecard_already_submitted/);
    const [after] = (await visibleScorecards(raterA.client, c.appId, raterA.id)).filter((x) => x.id === mine.id);
    expect(after.total).toBe(75);
  });

  it("validates cards: every question before submitting, 1–5 only, only the role's parts", async () => {
    const c = await liveCandidate("live-validate", BA);
    const keys = await keysFor(BA, c.appId, "live_defence");
    expect(msg(await score(raterA, BA, c.appId, "live_defence", { [keys[0]]: 3 }), "error")).toMatch(/Score every question/);
    expect(msg(await score(raterA, BA, c.appId, "live_defence", 7, "draft"), "error")).toMatch(/whole numbers from 1 to 5/);
    // A partial draft is fine and has no total yet.
    expect(msg(await score(raterA, BA, c.appId, "live_defence", { [keys[0]]: 3 }, "draft"), "ok")).toMatch(/Draft saved/);
    const [draft] = await visibleScorecards(raterA.client, c.appId, raterA.id);
    expect(draft).toMatchObject({ total: null, submitted_at: null, scores: { [keys[0]]: 3 } });
    // A BA has no exec scenario.
    h.client = raterA.client;
    const r = await outcome(saveScorecard(form({ application_id: c.appId, kind: "exec_scenario", intent: "draft" })));
    expect(msg(r, "error")).toMatch(/no exec_scenario scorecard/);
    // Not at the live stage → closed.
    seed(`update public.applications set stage = 'work_2' where id = '${c.appId}';`);
    expect(msg(await score(raterA, BA, c.appId, "live_defence", 3), "error")).toMatch(/not at the shortlist or live stage/);
  });
});

describe("database guard: direct writes through PostgREST (migration 0019)", () => {
  it("another panellist's DRAFT stays hidden even after you submit", async () => {
    const c = await liveCandidate("live-draft-hidden", SWE);
    expect(msg(await score(raterA, SWE, c.appId, "panel_interview", 3, "draft"), "ok")).toMatch(/Draft saved/);
    expect(msg(await score(raterB, SWE, c.appId, "panel_interview", 4), "ok")).toMatch(/submitted/);
    expect((await visibleScorecards(raterB.client, c.appId, raterB.id)).map((x) => x.rater)).toEqual([raterB.id]);
    const { data: direct } = await raterB.client.from("live_scorecards").select("rater, submitted_at").eq("application_id", c.appId);
    expect(direct).toEqual([{ rater: raterB.id, submitted_at: expect.any(String) }]);
    // Once A submits, B sees A's submitted card.
    expect(msg(await score(raterA, SWE, c.appId, "panel_interview", 3), "ok")).toMatch(/submitted/);
    expect((await visibleScorecards(raterB.client, c.appId, raterB.id)).map((x) => x.rater).sort()).toEqual([raterA.id, raterB.id].sort());
  });

  it("recomputes a submitted card's total and checks it against the card's questions", async () => {
    const c = await liveCandidate("live-guard-total", SWE);
    const keys = await keysFor(SWE, c.appId, "live_defence");
    const twos = Object.fromEntries(keys.map((k) => [k, 2]));
    const insert = (row: Record<string, unknown>) =>
      raterA.client.from("live_scorecards").insert({ application_id: c.appId, kind: "live_defence", ...row }).select("total, submitted_at").maybeSingle();

    // Scores under unknown keys, a partial card, a card without its questions: refused.
    expect((await insert({ scores: { anything: 5 }, total: 100, submitted_at: new Date().toISOString() })).error?.message).toMatch(/scorecard_questions_mismatch/);
    expect((await insert({ scores: { anything: 5 }, question_keys: keys, total: 100, submitted_at: new Date().toISOString() })).error?.message).toMatch(/scorecard_scores_invalid/);
    expect((await insert({ scores: { [keys[0]]: 5 }, question_keys: keys, total: 100, submitted_at: new Date().toISOString() })).error?.message).toMatch(/scorecard_scores_missing/);
    const madeUp = ["made_up", ...keys.slice(1)];
    expect((await insert({ scores: Object.fromEntries(madeUp.map((k) => [k, 2])), question_keys: madeUp, total: 100, submitted_at: new Date().toISOString() })).error?.message).toMatch(/scorecard_questions_mismatch/);
    expect((await insert({ scores: { ...twos, [keys[0]]: 7 }, question_keys: keys, submitted_at: new Date().toISOString() })).error?.message).toMatch(/scorecard_scores_invalid/);

    // A complete card: the client's total is ignored, the database computes it (all 2s → 25).
    const ok = await insert({ scores: twos, question_keys: keys, total: 100, submitted_at: new Date().toISOString() });
    expect(ok.error).toBeNull();
    expect(Number(ok.data!.total)).toBe(25);
    // A draft never carries a total.
    const draft = await raterB.client
      .from("live_scorecards")
      .insert({ application_id: c.appId, kind: "live_defence", scores: { [keys[0]]: 5 }, question_keys: keys, total: 100 })
      .select("total")
      .single();
    expect(draft.data?.total).toBeNull();

    // A part the role doesn't have, and 'portfolio' (no scorecard yet): refused.
    const exec = await raterA.client.from("live_scorecards").insert({ application_id: (await liveCandidate("live-guard-ba", BA)).appId, kind: "exec_scenario", scores: {} });
    expect(exec.error?.message).toMatch(/scorecard_kind_not_for_role/);
    const portfolio = await raterA.client.from("live_scorecards").insert({ application_id: c.appId, kind: "portfolio", scores: { x: "not a number" }, total: 100, submitted_at: new Date().toISOString() });
    expect(portfolio.error?.message).toMatch(/scorecard_kind_unsupported/);
  });

  it("refuses cards for an application outside the shortlist / live stage", async () => {
    const c = await liveCandidate("live-guard-stage", SWE);
    seed(`update public.applications set stage = 'work_1' where id = '${c.appId}';`);
    const { error } = await raterA.client.from("live_scorecards").insert({ application_id: c.appId, kind: "panel_interview", scores: { anything: 5 }, total: 100, submitted_at: new Date().toISOString() });
    expect(error?.message).toMatch(/application_not_at_live_stage/);
    const retest = await raterA.client.from("live_scorecards").insert({ application_id: c.appId, kind: "reasoning_retest", scores: { raw: 12, seed: 5 }, submitted_at: new Date().toISOString() });
    expect(retest.error?.message).toMatch(/application_not_at_live_stage/);
  });

  it("derives a retest's percentiles and delta from the raw score; no draft retests", async () => {
    const c = await liveCandidate("live-guard-retest", SWE);
    const draft = await raterA.client.from("live_scorecards").insert({ application_id: c.appId, kind: "reasoning_retest", scores: { raw: 12, seed: 5 } });
    expect(draft.error?.message).toMatch(/retest_must_be_submitted/);
    expect((await raterA.client.from("live_scorecards").insert({ application_id: c.appId, kind: "reasoning_retest", scores: { raw: 13, seed: 5 }, submitted_at: new Date().toISOString() })).error?.message).toMatch(/retest_raw_invalid/);
    expect((await raterA.client.from("live_scorecards").insert({ application_id: c.appId, kind: "reasoning_retest", scores: { raw: 12 }, submitted_at: new Date().toISOString() })).error?.message).toMatch(/retest_seed_invalid/);

    // Forged total and percentiles are replaced by the database's (online percentile 30, live from raw 12).
    const { data, error } = await raterA.client
      .from("live_scorecards")
      .insert({ application_id: c.appId, kind: "reasoning_retest", scores: { raw: 12, seed: 5, live_percentile: 0, delta: 0 }, total: 0, submitted_at: new Date().toISOString() })
      .select("total, scores")
      .single();
    expect(error).toBeNull();
    const live = livePercentile(12).percentile;
    expect(Number(data!.total)).toBe(live);
    expect(data!.scores).toEqual({ raw: 12, seed: 5, norm_version: "live-provisional-normal-v1", live_percentile: live, online_percentile: 30, delta: Math.round((30 - live) * 10) / 10 });
    const { data: app } = await admin.from("applications").select("live_delta").eq("id", c.appId).single();
    expect(Number(app!.live_delta)).toBe(Math.round((30 - live) * 10) / 10);

    // The SQL norm is the TypeScript one for every raw score.
    for (let raw = 0; raw <= 12; raw++) {
      const { data: pct } = await raterA.client.rpc("live_retest_percentile", { p_raw: raw });
      expect(Number(pct)).toBe(livePercentile(raw).percentile);
    }
  });
});

describe("final composite (docs/09 §2: 50% pre-live + 50% live)", () => {
  const parts = { reasoning: 30, interview: 60, quiz: 70, work_1: 50, work_2: 90 };
  const finalOf = async (appId: string) => {
    const { data } = await admin.from("applications").select("final_score").eq("id", appId).single();
    return data!.final_score === null ? null : Number(data!.final_score);
  };

  it.each([
    [SWE, { panel_interview: 4, live_defence: 3, exec_scenario: 5 }],
    [BA, { panel_interview: 4, live_defence: 2, live_elicitation: 5 }],
  ] as const)("%s: final_score appears once every live part has a submitted card", async (role, plan) => {
    const c = await liveCandidate(`live-final-${role}`, role);
    const kinds = kindsForRole(role);
    expect(Object.keys(plan).sort()).toEqual([...kinds].sort());
    const toTotal = (n: number) => ((n - 1) / 4) * 100;
    for (const [i, kind] of kinds.entries()) {
      expect(await finalOf(c.appId)).toBeNull();
      expect(msg(await score(raterA, role, c.appId, kind, plan[kind as keyof typeof plan]), "ok")).toMatch(/submitted/);
      if (i < kinds.length - 1) expect(await finalOf(c.appId)).toBeNull();
    }
    const live = liveComposite(role, Object.fromEntries(kinds.map((k) => [k, toTotal(plan[k as keyof typeof plan])])));
    const expected = finalComposite(preLiveComposite(role, parts), live);
    expect(expected).not.toBeNull();
    expect(await finalOf(c.appId)).toBe(expected);
    const [s] = await computeScores(admin, { applicationIds: [c.appId] });
    expect(s.final).toBe(expected);
    expect(s.live.coverage).toBe(1);
  });
});

describe("what each panellist may see of live and final scores (viewerLiveGate)", () => {
  it("B sees neither A's part score nor the final until B has submitted the same parts", async () => {
    const c = await liveCandidate("live-gate", SWE);
    const [pre] = await computeScores(admin, { applicationIds: [c.appId] });
    const gate = async (u: User) => (await viewerLiveGate(u.client, u.id, [{ applicationId: c.appId, roleSlug: SWE, preLive: pre.preLive }])).get(c.appId)!;

    expect(msg(await score(raterA, SWE, c.appId, "panel_interview", 5), "ok")).toMatch(/submitted/);
    // The service-role aggregate already has A's card; B's view doesn't.
    expect((await computeScores(admin, { applicationIds: [c.appId] }))[0].live.score).toBe(100);
    expect(await gate(raterB)).toMatchObject({ parts: {}, live: { score: null }, final: null, allSubmitted: false });
    expect((await gate(raterA)).parts).toEqual({ panel_interview: 100 });

    for (const kind of ["live_defence", "exec_scenario"] as const) expect(msg(await score(raterA, SWE, c.appId, kind, 5), "ok")).toMatch(/submitted/);
    expect((await gate(raterA)).final).not.toBeNull();
    expect((await gate(raterB)).final).toBeNull();
    // B submits one part: sees that part only (the mean of both cards), still no final.
    expect(msg(await score(raterB, SWE, c.appId, "panel_interview", 1), "ok")).toMatch(/submitted/);
    const b1 = await gate(raterB);
    expect(b1.parts).toEqual({ panel_interview: 50 });
    expect(b1.final).toBeNull();
    for (const kind of ["live_defence", "exec_scenario"] as const) expect(msg(await score(raterB, SWE, c.appId, kind, 1), "ok")).toMatch(/submitted/);
    const b2 = await gate(raterB);
    expect(b2.allSubmitted).toBe(true);
    const { data: app } = await admin.from("applications").select("final_score").eq("id", c.appId).single();
    expect(b2.final).toBe(Number(app!.final_score));
  });
});

describe("reasoning retest (docs/04 §6)", () => {
  it("prints a 12-item parallel form per candidate seed", async () => {
    const c = await liveCandidate("live-retest-form", SWE);
    const a = await retestForm(raterA.client, c.id, 4242);
    expect(a).toHaveLength(12);
    expect(await retestForm(raterA.client, c.id, 4242)).toEqual(a);
    expect((await retestForm(raterA.client, c.id, 4243)).map((i) => i.stem)).not.toEqual(a.map((i) => i.stem));
  });

  it("records raw → live percentile → delta; above 25 logs a live_delta signal for discussion", async () => {
    const c = await liveCandidate("live-retest-high", SWE);
    seed(`update public.reasoning_attempts set percentile = 90 where user_id = '${c.id}' and form = 'online';`);
    h.client = raterA.client;
    const live = livePercentile(3).percentile;
    const r = await outcome(recordRetest(form({ application_id: c.appId, raw: "3", seed: "12345" })));
    expect(msg(r, "ok")).toMatch(/Flagged for discussion in the room \(not a rejection\)/);
    expect(r !== "404" && r.pathname).toBe(`/admin/live/${c.appId}/retest`);

    const { data: card } = await admin.from("live_scorecards").select("scores, total, submitted_at, rater").eq("application_id", c.appId).eq("kind", "reasoning_retest").single();
    expect(card).toMatchObject({ rater: raterA.id, total: live, scores: { raw: 3, seed: 12345, online_percentile: 90, live_percentile: live, norm_version: "live-provisional-normal-v1" } });
    expect(card!.submitted_at).not.toBeNull();
    const delta = Math.round((90 - live) * 10) / 10;
    const { data: app } = await admin.from("applications").select("live_delta, status, final_score").eq("id", c.appId).single();
    expect(Number(app!.live_delta)).toBe(delta);
    expect(app!.status).toBe("in_progress"); // never a rejection
    const { data: signals } = await admin.from("signals").select("kind, context, payload").eq("user_id", c.id).eq("kind", "live_delta");
    expect(signals).toHaveLength(1);
    expect(signals![0]).toMatchObject({ context: "live_retest", payload: { application_id: c.appId, delta, raw: 3 } });
    // The retest is not part of any composite.
    const [s] = await computeScores(admin, { applicationIds: [c.appId] });
    expect(s.live.score).toBeNull();
    expect(s.liveDelta).toBe(delta);

    // Final, and validated.
    expect(msg(await outcome(recordRetest(form({ application_id: c.appId, raw: "9", seed: "12345" }))), "error")).toMatch(/already recorded/);
    h.client = raterB.client;
    const typo = await outcome(recordRetest(form({ application_id: c.appId, raw: "13", seed: "12345" })));
    expect(msg(typo, "error")).toMatch(/0 to 12/);
    // Back to the same printed form: the seed survives the error.
    expect(typo !== "404" && typo.searchParams.get("seed")).toBe("12345");
    expect(msg(await outcome(recordRetest(form({ application_id: c.appId, raw: "", seed: "12345" }))), "error")).toMatch(/raw score/);
  });

  it("a small delta is stored without a signal", async () => {
    const c = await liveCandidate("live-retest-low", BA);
    h.client = raterA.client;
    expect(msg(await outcome(recordRetest(form({ application_id: c.appId, raw: "4", seed: "777" }))), "ok")).not.toMatch(/Flagged/);
    const { data: app } = await admin.from("applications").select("live_delta").eq("id", c.appId).single();
    expect(Number(app!.live_delta)).toBe(Math.round((30 - livePercentile(4).percentile) * 10) / 10);
    const { data: signals } = await admin.from("signals").select("id").eq("user_id", c.id).eq("kind", "live_delta");
    expect(signals).toEqual([]);
  });
});

describe("access", () => {
  it("non-admins are refused by every live action and by RLS", async () => {
    const c = await liveCandidate("live-access", SWE);
    h.client = c.client;
    expect(await outcome(saveScorecard(form({ application_id: c.appId, kind: "panel_interview", intent: "draft" })))).toBe("404");
    expect(await outcome(recordRetest(form({ application_id: c.appId, raw: "12", seed: "1" })))).toBe("404");
    expect(await outcome(updateLiveQuestion(form({ id: randomUUID(), text: "x".repeat(20) })))).toBe("404");
    const { error } = await c.client.from("live_scorecards").insert({ application_id: c.appId, kind: "panel_interview", total: 100, submitted_at: new Date().toISOString() });
    expect(error).not.toBeNull();
    const { data: bank } = await c.client.from("live_questions").select("id");
    expect(bank).toEqual([]);
    const { data: cards } = await c.client.from("live_scorecards").select("id");
    expect(cards).toEqual([]);
  });

  it("admins can edit a bank question (anchors required)", async () => {
    const { data: q } = await admin.from("live_questions").select("id, text, probes, anchors, active, replaceable").eq("key", "swe_exec_export").single();
    h.client = raterA.client;
    const bad = await outcome(updateLiveQuestion(form({ id: q!.id, text: q!.text, probes: "", anchor1: "a", anchor3: "", anchor5: "c" })));
    expect(msg(bad, "error")).toMatch(/Every anchor/);
    try {
      const ok = await outcome(
        updateLiveQuestion(form({ id: q!.id, text: `${q!.text} (edited)`, probes: "One\nTwo", anchor1: "Weak answer", anchor3: "Middling answer", anchor5: "Strong answer", active: "on" })),
      );
      expect(msg(ok, "ok")).toMatch(/Saved swe_exec_export/);
      const { data: after } = await admin.from("live_questions").select("text, probes, anchors, active").eq("id", q!.id).single();
      expect(after).toMatchObject({ text: `${q!.text} (edited)`, probes: ["One", "Two"], anchors: { "1": "Weak answer", "3": "Middling answer", "5": "Strong answer" }, active: true });
    } finally {
      await admin.from("live_questions").update({ text: q!.text, probes: q!.probes, anchors: q!.anchors, active: q!.active, replaceable: q!.replaceable }).eq("id", q!.id);
    }
  });
});
