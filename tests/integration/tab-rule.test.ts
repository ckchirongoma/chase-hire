import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// Route tests: the "signed-in user" is whichever client h.client holds.
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));

import { answer as answerReasoning, finaliseExpired, getState as reasoningState, startAttempt } from "@/lib/server/reasoning";
import { answerQuiz, finaliseExpiredQuizzes, getQuizState, startQuiz, type QuizState } from "@/lib/server/quiz";
import { endExpiredInterviews, endInterviewEarly, getInterviewState, InterviewConflict, LOCKED_NOTICE, postInterviewMessage, startInterview } from "@/lib/server/interview";
import { markAway, markBack, recordTabLeave } from "@/lib/server/integrity";
import type { InterviewView } from "@/lib/interview/types";
import { POST as leaveRoute } from "@/app/api/integrity/leave/route";
import { POST as presenceRoute } from "@/app/api/integrity/presence/route";
import { anon, consent, fakeFinishedAttempt, fakeParsedCv, makeAdmin, newUser, psql, service } from "../helpers/local";

/**
 * The tab rule in the timed stages (reasoning test, role quiz, AI interview): the first leave
 * of 2 s or more pauses, the second locks until an admin reopens it with the time that was left.
 * Locks are never rejections, never expire on their own and are never auto-finalised.
 */

const admin = service();
type Live = Extract<InterviewView, { status: "active" | "done" }>;
type QuizActive = Extract<QuizState, { status: "active" }>;
const BA = "business-analyst";
const REASON = "Candidate emailed: their laptop restarted during the test.";

let boss: Awaited<ReturnType<typeof newUser>>;
beforeAll(async () => {
  boss = await newUser("tab-admin");
  await makeAdmin(boss.id);
});

const reopen = (client: SupabaseClient, kind: string, id: string, reason = REASON) =>
  client.rpc("admin_reopen_session", { p_kind: kind, p_id: id, p_reason: reason });

async function signals(userId: string, kind: string) {
  const { data } = await admin.from("signals").select("context, kind, payload").eq("user_id", userId).eq("kind", kind);
  return data ?? [];
}

async function applicant(tag: string) {
  const u = await newUser(tag);
  await consent(u.client);
  await fakeParsedCv(u.id);
  await fakeFinishedAttempt(u.id, 4);
  const { data, error } = await u.client.rpc("apply_to_role", { p_slug: BA });
  if (error) throw error;
  return { ...u, appId: data as string };
}

describe("tab rule: reasoning assessment", () => {
  it("ignores short blips, pauses on the first leave, locks on the second, and logs signals", async () => {
    const u = await newUser("tab-reasoning");
    await consent(u.client);
    await fakeParsedCv(u.id);
    const s = await startAttempt(admin, u.id);
    if (s.status !== "active") throw new Error("expected an active attempt");

    expect(await recordTabLeave(admin, u.id, "reasoning", s.attemptId, 1500)).toBe("ignored");
    expect(await recordTabLeave(admin, u.id, "reasoning", s.attemptId, 4000)).toBe("paused");
    expect((await reasoningState(admin, u.id)).status).toBe("active"); // a pause doesn't stop the clock or the test
    expect(await signals(u.id, "tab_pause")).toEqual([
      { context: "reasoning", kind: "tab_pause", payload: { id: s.attemptId, hidden_ms: 4000, leaves: 1 } },
    ]);

    expect(await recordTabLeave(admin, u.id, "reasoning", s.attemptId, 3000)).toBe("locked");
    expect(await recordTabLeave(admin, u.id, "reasoning", s.attemptId, 3000)).toBe("locked"); // idempotent while locked
    expect(await signals(u.id, "session_locked")).toHaveLength(1);
    expect(await reasoningState(admin, u.id)).toEqual({ status: "locked", attemptId: s.attemptId });

    // Answers are refused while locked: through the app and directly in the DB.
    const pos = s.item.position;
    expect(await answerReasoning(admin, u.id, s.attemptId, pos, 0)).toEqual({ status: "locked", attemptId: s.attemptId });
    const direct = await admin
      .from("reasoning_responses")
      .update({ answer: 0, answered_at: new Date().toISOString() })
      .eq("attempt_id", s.attemptId)
      .eq("position", pos);
    expect(direct.error?.message).toMatch(/session_locked/);
    const { data: row } = await admin.from("reasoning_responses").select("answered_at").eq("attempt_id", s.attemptId).eq("position", pos).single();
    expect(row!.answered_at).toBeNull();

    // A locked attempt is never finalised by the sweep, even past its deadline.
    psql(`alter table public.reasoning_attempts disable trigger reasoning_attempts_guard;
          update public.reasoning_attempts set started_at = now() - interval '30 minutes', deadline_at = now() - interval '10 minutes',
                 locked_at = now() - interval '20 minutes' where id = '${s.attemptId}';
          alter table public.reasoning_attempts enable trigger reasoning_attempts_guard;`);
    await finaliseExpired(admin);
    const { data: still } = await admin.from("reasoning_attempts").select("submitted_at, stars").eq("id", s.attemptId).single();
    expect(still).toEqual({ submitted_at: null, stars: null });
    expect((await reasoningState(admin, u.id)).status).toBe("locked");

    // The candidate can't clear the lock themselves.
    const self = await u.client.from("reasoning_attempts").update({ locked_at: null }).eq("id", s.attemptId).select("id");
    expect(self.error !== null || (self.data ?? []).length === 0).toBe(true);
    const selfReopen = await reopen(u.client, "reasoning", s.attemptId);
    expect(selfReopen.error?.message).toMatch(/admin_only/);

    // Admin reopen: the time left when it locked (10 minutes) is given back.
    expect((await reopen(boss.client, "reasoning", s.attemptId, "too short")).error?.message).toMatch(/reason_too_short/);
    const { data: newDeadline, error } = await reopen(boss.client, "reasoning", s.attemptId);
    expect(error).toBeNull();
    const left = new Date(newDeadline as string).getTime() - Date.now();
    expect(left).toBeGreaterThan(9.5 * 60_000);
    expect(left).toBeLessThanOrEqual(10 * 60_000 + 1000);
    const { data: att } = await admin.from("reasoning_attempts").select("locked_at, tab_leaves, reopen_count, deadline_at").eq("id", s.attemptId).single();
    expect(att).toMatchObject({ locked_at: null, tab_leaves: 1, reopen_count: 1 });
    const [reopened] = await signals(u.id, "session_reopened");
    expect(reopened.payload).toMatchObject({ id: s.attemptId, by: boss.id, reason: REASON });

    const back = await reasoningState(admin, u.id);
    expect(back.status).toBe("active");
    const answered = await answerReasoning(admin, u.id, s.attemptId, pos, 0);
    expect(answered.status).toBe("active");
    // The next leave locks again straight away (one pause per attempt).
    expect(await recordTabLeave(admin, u.id, "reasoning", s.attemptId, 2500)).toBe("locked");
    expect((await reopen(boss.client, "reasoning", s.attemptId)).error).toBeNull();

    // Reopening something that isn't locked is refused.
    expect((await reopen(boss.client, "reasoning", s.attemptId)).error?.message).toMatch(/not_locked/);
  });

  it("gives back at least a minute, and ignores leaves on a finished attempt or someone else's", async () => {
    const u = await newUser("tab-minute");
    await consent(u.client);
    await fakeParsedCv(u.id);
    const s = await startAttempt(admin, u.id);
    if (s.status !== "active") throw new Error("expected an active attempt");
    const other = await newUser("tab-other");
    await expect(recordTabLeave(admin, other.id, "reasoning", s.attemptId, 5000)).rejects.toMatchObject({ status: 404 });

    await recordTabLeave(admin, u.id, "reasoning", s.attemptId, 5000);
    await recordTabLeave(admin, u.id, "reasoning", s.attemptId, 5000);
    // Locked after the deadline had (somehow) already passed: still a minute to finish.
    psql(`alter table public.reasoning_attempts disable trigger reasoning_attempts_guard;
          update public.reasoning_attempts set started_at = now() - interval '30 minutes', deadline_at = now() - interval '10 minutes'
           where id = '${s.attemptId}';
          alter table public.reasoning_attempts enable trigger reasoning_attempts_guard;`);
    const { data: d } = await reopen(boss.client, "reasoning", s.attemptId);
    const left = new Date(d as string).getTime() - Date.now();
    expect(left).toBeGreaterThan(55_000);
    expect(left).toBeLessThanOrEqual(61_000);

    psql(`update public.reasoning_attempts set submitted_at = now(), raw_score = 0, percentile = 1, stars = 1, norm_version = 't' where id = '${s.attemptId}'`);
    expect(await recordTabLeave(admin, u.id, "reasoning", s.attemptId, 5000)).toBe("ignored");
  });
});

describe("tab rule: role quiz", () => {
  it("pauses, locks, refuses answers, survives the sweep, and reopens with the time left", async () => {
    const u = await applicant("tab-quiz");
    psql(`alter table public.applications disable trigger applications_status_guard;
          update public.applications set stage = 'quiz', status = 'in_progress' where id = '${u.appId}';
          alter table public.applications enable trigger applications_status_guard;`);
    const s = (await startQuiz(admin, u.id, BA)) as QuizActive;
    expect(s.status).toBe("active");

    expect(await recordTabLeave(admin, u.id, "quiz", s.attemptId, 3000)).toBe("paused");
    expect(await recordTabLeave(admin, u.id, "quiz", s.attemptId, 3000)).toBe("locked");
    expect(await getQuizState(admin, u.id, BA)).toEqual({ status: "locked", attemptId: s.attemptId });
    expect(await answerQuiz(admin, u.id, BA, s.attemptId, s.item.position, [0])).toEqual({ status: "locked", attemptId: s.attemptId });
    const direct = await admin
      .from("quiz_responses")
      .update({ answer: [0], answered_at: new Date().toISOString() })
      .eq("attempt_id", s.attemptId)
      .eq("position", s.item.position);
    expect(direct.error?.message).toMatch(/session_locked/);

    psql(`alter table public.quiz_attempts disable trigger quiz_attempts_guard;
          update public.quiz_attempts set started_at = now() - interval '20 minutes', deadline_at = now() - interval '8 minutes',
                 locked_at = now() - interval '13 minutes' where id = '${s.attemptId}';
          alter table public.quiz_attempts enable trigger quiz_attempts_guard;`);
    await finaliseExpiredQuizzes(admin);
    const { data: still } = await admin.from("quiz_attempts").select("submitted_at").eq("id", s.attemptId).single();
    expect(still!.submitted_at).toBeNull();
    const { data: app } = await admin.from("applications").select("stage, status").eq("id", u.appId).single();
    expect(app).toEqual({ stage: "quiz", status: "in_progress" }); // never a rejection

    const { data: d, error } = await reopen(boss.client, "quiz", s.attemptId);
    expect(error).toBeNull();
    const left = new Date(d as string).getTime() - Date.now();
    expect(left).toBeGreaterThan(4.5 * 60_000); // 5 minutes were left when it locked
    expect(left).toBeLessThanOrEqual(5 * 60_000 + 1000);
    const back = (await getQuizState(admin, u.id, BA)) as QuizActive;
    expect(back.status).toBe("active");
    expect((await answerQuiz(admin, u.id, BA, s.attemptId, back.item.position, [0])).status).toBe("active");
  });
});

describe("tab rule: AI interview", () => {
  it("locks the conversation on the second leave; an admin reopens it and the candidate carries on", async () => {
    const u = await applicant("tab-interview");
    psql(`update public.applications set interview_answer_mode = 'typed' where id = '${u.appId}'`);
    let s = (await startInterview(admin, u.id, u.appId)) as Live;

    expect(await recordTabLeave(admin, u.id, "interview", s.sessionId, 2000)).toBe("paused");
    expect((await getInterviewState(admin, u.id, u.appId)) as Live).toMatchObject({ status: "active", locked: false, tabLeaves: 1 });
    expect(await recordTabLeave(admin, u.id, "interview", s.sessionId, 9000)).toBe("locked");

    const locked = (await getInterviewState(admin, u.id, u.appId)) as Live;
    expect(locked).toMatchObject({ status: "active", locked: true, notice: LOCKED_NOTICE });
    expect(LOCKED_NOTICE).toMatch(/not a rejection/);
    const refused = await postInterviewMessage(admin, u.id, u.appId, { content: "My answer.", turn: s.turn }).catch((e) => e);
    expect(refused).toBeInstanceOf(InterviewConflict);
    expect(refused.message).toBe(LOCKED_NOTICE);
    const direct = await admin.from("interview_messages").insert({ session_id: s.sessionId, role: "candidate", content: "sneaky" });
    expect(direct.error?.message).toMatch(/session_locked/);

    // Past its deadline, a locked interview is neither ended by a read nor by the sweep.
    psql(`alter table public.interview_sessions disable trigger interview_sessions_guard;
          update public.interview_sessions set started_at = now() - interval '50 minutes', deadline_at = now() - interval '15 minutes',
                 locked_at = now() - interval '30 minutes' where id = '${s.sessionId}';
          alter table public.interview_sessions enable trigger interview_sessions_guard;`);
    await endExpiredInterviews(admin);
    expect((await getInterviewState(admin, u.id, u.appId)) as Live).toMatchObject({ status: "active", locked: true, endReason: null });

    const { data: d, error } = await reopen(boss.client, "interview", s.sessionId);
    expect(error).toBeNull();
    const left = new Date(d as string).getTime() - Date.now();
    expect(left).toBeGreaterThan(14.5 * 60_000);
    expect(left).toBeLessThanOrEqual(15 * 60_000 + 1000);

    s = (await getInterviewState(admin, u.id, u.appId)) as Live;
    expect(s).toMatchObject({ status: "active", locked: false, notice: null, tabLeaves: 1 });
    s = (await postInterviewMessage(admin, u.id, u.appId, { content: "I build reporting pipelines in SQL and Python for 4 teams.", turn: s.turn })) as Live;
    expect(s.lastAnswer).toBe("saved");
    const { data: app } = await admin.from("applications").select("stage, status").eq("id", u.appId).single();
    expect(app).toEqual({ stage: "interview", status: "in_progress" });
  });
});

describe("interview answer mode (accommodation)", () => {
  it("only an admin, with a reason, and only before the interview starts", async () => {
    const u = await applicant("mode");
    const set = (client: SupabaseClient, mode: string, reason = "Candidate has no working microphone (review request).") =>
      client.rpc("admin_set_interview_mode", { p_application_id: u.appId, p_mode: mode, p_reason: reason });

    expect((await set(u.client, "typed")).error?.message).toMatch(/admin_only/);
    expect((await set(boss.client, "typed", "short")).error?.message).toMatch(/reason_too_short/);
    expect((await set(boss.client, "sign-language")).error?.message).toMatch(/invalid_mode/);
    expect((await set(boss.client, "typed")).error).toBeNull();
    const { data: app } = await admin.from("applications").select("interview_answer_mode, interview_mode_reason, interview_mode_set_by").eq("id", u.appId).single();
    expect(app).toEqual({ interview_answer_mode: "typed", interview_mode_reason: "Candidate has no working microphone (review request).", interview_mode_set_by: boss.id });

    // Candidates can't change it themselves.
    const self = await u.client.from("applications").update({ interview_answer_mode: "voice" }).eq("id", u.appId).select("id");
    expect(self.error !== null || (self.data ?? []).length === 0).toBe(true);

    const s = (await startInterview(admin, u.id, u.appId)) as Live;
    expect(s.answerMode).toBe("typed");
    expect((await set(boss.client, "voice")).error?.message).toMatch(/interview_already_started/);
  });
});

describe("POST /api/integrity/leave", () => {
  const req = (body: unknown) =>
    new Request("http://localhost/api/integrity/leave", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("needs a signed-in owner and a valid body, then reports paused / locked", async () => {
    const u = await newUser("tab-route");
    await consent(u.client);
    await fakeParsedCv(u.id);
    const s = await startAttempt(admin, u.id);
    if (s.status !== "active") throw new Error("expected an active attempt");

    h.client = anon();
    expect((await leaveRoute(req({ kind: "reasoning", id: s.attemptId, hiddenMs: 3000 }))).status).toBe(401);

    h.client = u.client;
    expect((await leaveRoute(req({ kind: "lunch", id: s.attemptId, hiddenMs: 3000 }))).status).toBe(400);
    expect((await leaveRoute(req({ kind: "reasoning", id: "nope", hiddenMs: 3000 }))).status).toBe(400);
    expect((await leaveRoute(req({ kind: "reasoning", id: s.attemptId, hiddenMs: -1 }))).status).toBe(400);
    const other = await newUser("tab-route-other");
    h.client = other.client;
    expect((await leaveRoute(req({ kind: "reasoning", id: s.attemptId, hiddenMs: 3000 }))).status).toBe(404);

    h.client = u.client;
    expect(await (await leaveRoute(req({ kind: "reasoning", id: s.attemptId, hiddenMs: 1000 }))).json()).toEqual({ status: "ignored" });
    expect(await (await leaveRoute(req({ kind: "reasoning", id: s.attemptId, hiddenMs: 3000 }))).json()).toEqual({ status: "paused" });
    expect(await (await leaveRoute(req({ kind: "reasoning", id: s.attemptId, hiddenMs: 3000 }))).json()).toEqual({ status: "locked" });
  });

  it("anon and candidates cannot call record_tab_leave directly", async () => {
    const u = await newUser("tab-rpc");
    for (const client of [anon(), u.client]) {
      const { error } = await client.rpc("record_tab_leave", { p_kind: "reasoning", p_id: u.id, p_user: u.id, p_hidden_ms: 5000 });
      expect(error).not.toBeNull();
    }
  });
});

describe("tab rule: closing the tab, reloading or navigating away", () => {
  // Pretend the page went away `ms` ago (the DB clock times the absence).
  const awayFor = (table: string, id: string, ms: number) =>
    admin.from(table).update({ away_since: new Date(Date.now() - ms).toISOString() }).eq("id", id);

  it("counts a close-and-reopen like a tab switch: pause, then lock; a quick reload is ignored", async () => {
    const u = await newUser("tab-close");
    await consent(u.client);
    await fakeParsedCv(u.id);
    const s = await startAttempt(admin, u.id);
    if (s.status !== "active") throw new Error("expected an active attempt");

    // Fresh page, never away.
    expect(await markBack(admin, u.id, "reasoning", s.attemptId, null)).toBe("ignored");
    // Reload: away then back within a second.
    await markAway(admin, u.id, "reasoning", s.attemptId, "closed");
    expect(await markBack(admin, u.id, "reasoning", s.attemptId, null)).toBe("ignored");
    expect(await signals(u.id, "page_closed")).toHaveLength(1);

    // Closed the tab and came back 40 s later: paused.
    await markAway(admin, u.id, "reasoning", s.attemptId, "closed");
    await awayFor("reasoning_attempts", s.attemptId, 40_000);
    expect(await markBack(admin, u.id, "reasoning", s.attemptId, null)).toBe("paused");
    const [pause] = await signals(u.id, "tab_pause");
    expect(pause.payload.hidden_ms).toBeGreaterThanOrEqual(40_000);

    // A second time: locked, and the away clock is cleared.
    await markAway(admin, u.id, "reasoning", s.attemptId, "hidden");
    await awayFor("reasoning_attempts", s.attemptId, 10_000);
    expect(await markBack(admin, u.id, "reasoning", s.attemptId, null)).toBe("locked");
    const { data } = await admin.from("reasoning_attempts").select("away_since, locked_at").eq("id", s.attemptId).single();
    expect(data!.away_since).toBeNull();
    expect(data!.locked_at).not.toBeNull();
    // A locked stage doesn't start a new away clock.
    await markAway(admin, u.id, "reasoning", s.attemptId, "closed");
    expect((await admin.from("reasoning_attempts").select("away_since").eq("id", s.attemptId).single()).data!.away_since).toBeNull();
  });

  it("a late 'away' beacon can't inflate a short hide; someone else's session is not found", async () => {
    const u = await applicant("tab-stale");
    psql(`alter table public.applications disable trigger applications_status_guard;
          update public.applications set stage = 'quiz', status = 'in_progress' where id = '${u.appId}';
          alter table public.applications enable trigger applications_status_guard;`);
    const q = await startQuiz(admin, u.id, BA);
    if (q.status !== "active") throw new Error("expected an active quiz");
    await awayFor("quiz_attempts", q.attemptId, 60_000);
    // The page says it was hidden for half a second: 0.5 s + 5 s slack < 2 s? No: 5.5 s, so it still counts,
    // but it is capped at what the page saw, not the 60 s of the stale timestamp.
    expect(await markBack(admin, u.id, "quiz", q.attemptId, 500)).toBe("paused");
    const [pause] = await signals(u.id, "tab_pause");
    expect(pause.payload.hidden_ms).toBe(5500);

    const other = await newUser("tab-stale-other");
    await expect(markBack(admin, other.id, "quiz", q.attemptId, null)).rejects.toMatchObject({ status: 404 });
    // Marking someone else's session away does nothing.
    await markAway(admin, other.id, "quiz", q.attemptId, "closed");
    expect((await admin.from("quiz_attempts").select("away_since").eq("id", q.attemptId).single()).data!.away_since).toBeNull();
  });

  it("POST /api/integrity/presence: away then back through the route, for the signed-in owner only", async () => {
    const u = await applicant("tab-presence");
    const s = (await startInterview(admin, u.id, u.appId)) as Live;
    const post = (body: unknown) =>
      presenceRoute(new Request("http://x/api/integrity/presence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

    h.client = anon();
    expect((await post({ event: "away", kind: "interview", id: s.sessionId, reason: "closed" })).status).toBe(401);
    h.client = u.client;
    expect((await post({ event: "away", kind: "interview", id: s.sessionId })).status).toBe(400);
    expect(await (await post({ event: "away", kind: "interview", id: s.sessionId, reason: "closed" })).json()).toEqual({ status: "away" });
    await awayFor("interview_sessions", s.sessionId, 30_000);
    expect(await (await post({ event: "back", kind: "interview", id: s.sessionId, hiddenMs: null })).json()).toEqual({ status: "paused" });
    expect(await (await post({ event: "back", kind: "interview", id: s.sessionId, hiddenMs: null })).json()).toEqual({ status: "ignored" });
    expect(await signals(u.id, "page_closed")).toHaveLength(1);
  });
});

describe("ending the AI interview early", () => {
  it("ends it, keeps what was answered, moves on to the quiz and queues grading", async () => {
    const u = await applicant("end-early");
    psql(`update public.applications set interview_answer_mode = 'typed' where id = '${u.appId}'`);
    await expect(endInterviewEarly(admin, u.id, u.appId)).rejects.toMatchObject({ status: 409 }); // not started
    const s = (await startInterview(admin, u.id, u.appId)) as Live;
    await postInterviewMessage(admin, u.id, u.appId, {
      content: "I have run discovery with operations teams for four years and built the dashboards they use every day, mostly in SQL and Power BI.",
      turn: s.turn,
    });

    const other = await newUser("end-early-other");
    await expect(endInterviewEarly(admin, other.id, u.appId)).rejects.toMatchObject({ status: 404 });

    const done = (await endInterviewEarly(admin, u.id, u.appId)) as Live;
    expect(done).toMatchObject({ status: "done", done: true, endReason: "ended_by_candidate", current: null });
    expect(done.messages.at(-1)).toMatchObject({ step: "close" });
    expect(done.messages.at(-1)!.content).toMatch(/You've ended the interview/);
    expect(done.messages.filter((m) => m.role === "candidate")).toHaveLength(1);
    // Idempotent: ending again just returns the finished state.
    expect(((await endInterviewEarly(admin, u.id, u.appId)) as Live).messages).toHaveLength(done.messages.length);

    const { data: app } = await admin.from("applications").select("stage, status").eq("id", u.appId).single();
    expect(app).toEqual({ stage: "quiz", status: "in_progress" });
    const { data: jobs } = await admin.from("grading_jobs").select("subject_type").eq("subject_id", done.sessionId);
    expect(jobs?.map((j) => j.subject_type)).toEqual(["interview"]);
  });

  it("a locked interview can't be ended by the candidate", async () => {
    const u = await applicant("end-locked");
    const s = (await startInterview(admin, u.id, u.appId)) as Live;
    await recordTabLeave(admin, u.id, "interview", s.sessionId, 3000);
    await recordTabLeave(admin, u.id, "interview", s.sessionId, 3000);
    await expect(endInterviewEarly(admin, u.id, u.appId)).rejects.toMatchObject({ status: 409 });
  });
});
