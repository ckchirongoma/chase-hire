import { beforeAll, describe, expect, it, vi } from "vitest";

// Route handlers and admin actions read the session through this module (cookies in Next);
// tests hand them a signed-in (or signed-out) supabase-js client instead.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { answerQuiz, finaliseExpiredQuizzes, getQuizState, startQuiz, type QuizState } from "@/lib/server/quiz";
import { BLUEPRINT } from "@/lib/quiz/blueprint";
import { POST as startRoute } from "@/app/api/quiz/[role]/start/route";
import { GET as stateRoute } from "@/app/api/quiz/[role]/state/route";
import { POST as nextRoute } from "@/app/api/quiz/[role]/next/route";
import { GET as sweepRoute } from "@/app/api/quiz/finalise-expired/route";
import { addQuizItem, toggleQuizItem } from "@/app/admin/quiz-bank/actions";
import { anon, consent, fakeFinishedAttempt, fakeParsedCv, makeAdmin, newUser, psql, service } from "../helpers/local";

type Active = Extract<QuizState, { status: "active" }>;
type Done = Extract<QuizState, { status: "done" }>;
const admin = service();
const SWE = "software-engineer";
const BA = "business-analyst";
const sessionAs = vi.mocked(createClient);
const signIn = (client: SupabaseClient) => sessionAs.mockResolvedValue(client as never);

let boss: Awaited<ReturnType<typeof newUser>>;
beforeAll(async () => {
  boss = await newUser("quiz-admin");
  await makeAdmin(boss.id);
});

/** An admin decision through the real admin_decide() RPC, as the admin user. */
async function decide(appId: string, decision: "advance" | "reject" | "hold") {
  const { error } = await boss.client.rpc("admin_decide", {
    p_application_id: appId,
    p_decision: decision,
    p_reason: `Integration test: ${decision} after reviewing the evidence.`,
  });
  if (error) throw error;
}

async function applicant(tag: string, role: string) {
  const u = await newUser(tag);
  await consent(u.client);
  await fakeParsedCv(u.id);
  await fakeFinishedAttempt(u.id, 4);
  const { data, error } = await u.client.rpc("apply_to_role", { p_slug: role });
  if (error) throw error;
  return { ...u, appId: data as string };
}

/** Test setup only: put an application at the quiz stage (the guard trigger forbids this outside admin_decide). */
function moveToQuiz(appId: string, status = "in_progress") {
  psql(`alter table public.applications disable trigger applications_status_guard;
        update public.applications set stage = 'quiz', status = '${status}' where id = '${appId}';
        alter table public.applications enable trigger applications_status_guard;`);
}

/** Test setup only: move an attempt's clock into the past (the deadline is otherwise immutable). */
function expire(attemptId: string) {
  psql(`alter table public.quiz_attempts disable trigger quiz_attempts_guard;
        update public.quiz_attempts set started_at = now() - interval '20 minutes', deadline_at = now() - interval '8 minutes' where id = '${attemptId}';
        alter table public.quiz_attempts enable trigger quiz_attempts_guard;`);
}

/** Test setup only: make an attempt look `seconds` old without expiring it. */
function age(attemptId: string, seconds: number) {
  psql(`alter table public.quiz_attempts disable trigger quiz_attempts_guard;
        update public.quiz_attempts set started_at = now() - interval '${seconds} seconds' where id = '${attemptId}';
        alter table public.quiz_attempts enable trigger quiz_attempts_guard;`);
}

/** Test setup only: an attempt row with no questions (what a crash mid-start used to leave). */
async function emptyAttempt(appId: string, userId: string) {
  const { data, error } = await admin
    .from("quiz_attempts")
    .insert({ application_id: appId, user_id: userId, seed: 1, deadline_at: new Date(Date.now() + 60_000).toISOString() })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

async function stored(attemptId: string, position: number) {
  const { data, error } = await admin
    .from("quiz_responses")
    .select("item_id, answer_key, rendered")
    .eq("attempt_id", attemptId)
    .eq("position", position)
    .single();
  if (error) throw error;
  return data as { item_id: string; answer_key: number[]; rendered: { options: string[]; multi: boolean } };
}

function wrongAnswer(key: number[], n: number, multi: boolean): number[] {
  return multi ? key.slice(0, -1) : [(key[0]! + 1) % n];
}

async function application(appId: string) {
  const { data } = await admin.from("applications").select("stage, status").eq("id", appId).single();
  return data!;
}

describe("role quiz: gating", () => {
  it("cannot start unless the application is at the quiz stage and open", async () => {
    const u = await applicant("quiz-gate", SWE);
    await expect(startQuiz(admin, u.id, SWE)).rejects.toMatchObject({ status: 403 });
    expect(await getQuizState(admin, u.id, SWE)).toEqual({ status: "none", canStart: false });
    await expect(startQuiz(admin, u.id, BA)).rejects.toMatchObject({ status: 404 }); // not applied
    await expect(startQuiz(admin, u.id, "no-such-role")).rejects.toMatchObject({ status: 404 });

    moveToQuiz(u.appId, "awaiting_review"); // e.g. an admin hold
    await expect(startQuiz(admin, u.id, SWE)).rejects.toMatchObject({ status: 403 });

    moveToQuiz(u.appId, "in_progress");
    expect(await getQuizState(admin, u.id, SWE)).toEqual({ status: "none", canStart: true });
  });

  it("an admin-advanced application can start, and goes back to in_progress", async () => {
    const u = await applicant("quiz-adv", BA);
    moveToQuiz(u.appId, "advanced");
    const s = await startQuiz(admin, u.id, BA);
    expect(s.status).toBe("active");
    expect(await application(u.appId)).toEqual({ stage: "quiz", status: "in_progress" });
  });
});

describe("role quiz: full attempt through the server functions", () => {
  it("serves 15 items one at a time without keys, marks server-side and leaves the decision to an admin", async () => {
    const u = await applicant("quiz-full", SWE);
    moveToQuiz(u.appId);

    let s = (await startQuiz(admin, u.id, SWE)) as Active;
    expect(s.status).toBe("active");
    expect(s.item.position).toBe(1);
    expect(s.item.total).toBe(15);
    expect(s.item.options.length).toBeGreaterThanOrEqual(4);
    // Only what the candidate needs: no key, item id, topic or seed.
    expect(Object.keys(s).sort()).toEqual(["attemptId", "deadlineAt", "item", "serverNow", "status"]);
    expect(Object.keys(s.item).sort()).toEqual(["multi", "options", "position", "stem", "total"]);

    // The DB clock set a 12-minute deadline, and 15 rows stratified by the blueprint.
    const { data: attempt } = await admin.from("quiz_attempts").select("started_at, deadline_at").eq("id", s.attemptId).single();
    expect(new Date(attempt!.deadline_at).getTime() - new Date(attempt!.started_at).getTime()).toBe(12 * 60 * 1000);
    const { data: rows } = await admin.from("quiz_responses").select("topic, item_id").eq("attempt_id", s.attemptId);
    expect(rows).toHaveLength(15);
    expect(new Set(rows!.map((r) => r.item_id)).size).toBe(15);
    for (const { topic, count } of BLUEPRINT[SWE]) expect(rows!.filter((r) => r.topic === topic)).toHaveLength(count);

    // Starting again resumes the same attempt at the same item.
    const resumed = (await startQuiz(admin, u.id, SWE)) as Active;
    expect(resumed.attemptId).toBe(s.attemptId);
    expect(resumed.item.position).toBe(1);

    // Serving an item counts one exposure.
    const p2 = await stored(s.attemptId, 2);
    const { data: before } = await admin.from("quiz_items").select("exposures").eq("id", p2.item_id).single();

    // 9 correct, 3 wrong, 3 skipped (one as an empty list).
    let final: QuizState = s;
    for (let pos = 1; pos <= 15; pos++) {
      expect(s.item.position).toBe(pos);
      const { answer_key, rendered } = await stored(s.attemptId, pos);
      const choice =
        pos <= 9 ? [...answer_key].reverse() : pos <= 12 ? wrongAnswer(answer_key, rendered.options.length, rendered.multi) : pos === 13 ? [] : null;
      final = await answerQuiz(admin, u.id, SWE, s.attemptId, pos, choice);
      if (pos === 1) {
        const { data: after } = await admin.from("quiz_items").select("exposures").eq("id", p2.item_id).single();
        expect(after!.exposures).toBe(before!.exposures + 1);
      }
      if (pos < 15) s = final as Active;
    }

    expect(final.status).toBe("done");
    const { result } = final as Done;
    expect(result.rawScore).toBe(9);
    expect(result.total).toBe(15);
    expect(result.pct).toBe(60);
    const topics = Object.values(result.topicScores);
    expect(topics.reduce((n, t) => n + t.total, 0)).toBe(15);
    expect(topics.reduce((n, t) => n + t.correct, 0)).toBe(9);
    for (const { topic, count } of BLUEPRINT[SWE]) expect(result.topicScores[topic]!.total).toBe(count);

    const { data: row } = await admin.from("quiz_attempts").select("raw_score, pct, below_flag, submitted_at").eq("id", s.attemptId).single();
    expect(row).toMatchObject({ raw_score: 9, pct: 60, below_flag: false }); // SWE flag line is 55%
    expect(row!.submitted_at).not.toBeNull();

    const { data: marked } = await admin.from("quiz_responses").select("position, answer, correct").eq("attempt_id", s.attemptId).order("position");
    expect(marked!.filter((r) => r.correct).map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(marked!.filter((r) => r.position >= 13).map((r) => r.answer)).toEqual([null, null, null]);

    // No automatic stage move: the application waits for an admin.
    expect(await application(u.appId)).toEqual({ stage: "quiz", status: "awaiting_review" });

    // Done is final; the state endpoint keeps returning the result.
    expect(await getQuizState(admin, u.id, SWE)).toMatchObject({ status: "done", result: { rawScore: 9 } });
    const tamper = await admin.from("quiz_attempts").update({ raw_score: 15 }).eq("id", s.attemptId);
    expect(tamper.error?.message).toMatch(/already_submitted/);
  });

  it("flags a below-line result for review without rejecting it", async () => {
    const u = await applicant("quiz-below", BA);
    moveToQuiz(u.appId);
    let s = (await startQuiz(admin, u.id, BA)) as Active;
    let state: QuizState = s;
    for (let pos = 1; pos <= 15; pos++) {
      const { answer_key } = await stored(s.attemptId, pos);
      state = await answerQuiz(admin, u.id, BA, s.attemptId, pos, pos <= 7 ? answer_key : null);
      if (pos < 15) s = state as Active;
    }
    expect((state as Done).result).toMatchObject({ rawScore: 7, pct: 46.7 });
    const { data: row } = await admin.from("quiz_attempts").select("below_flag").eq("id", s.attemptId).single();
    expect(row!.below_flag).toBe(true); // BA flag line is 50%
    expect(await application(u.appId)).toEqual({ stage: "quiz", status: "awaiting_review" });
  });

  it("refuses several answers on a single-answer item and options that don't exist", async () => {
    const u = await applicant("quiz-shape", SWE);
    moveToQuiz(u.appId);
    let s = (await startQuiz(admin, u.id, SWE)) as Active;
    while (s.item.multi) s = (await answerQuiz(admin, u.id, SWE, s.attemptId, s.item.position, null)) as Active;
    await expect(answerQuiz(admin, u.id, SWE, s.attemptId, s.item.position, [0, 1])).rejects.toMatchObject({ status: 400 });
    await expect(answerQuiz(admin, u.id, SWE, s.attemptId, s.item.position, [s.item.options.length])).rejects.toMatchObject({ status: 400 });
    const still = (await getQuizState(admin, u.id, SWE)) as Active;
    expect(still.item.position).toBe(s.item.position);
  });

  it("ignores answers to earlier or unserved positions (no going back, no skipping ahead)", async () => {
    const u = await applicant("quiz-nav", BA);
    moveToQuiz(u.appId);
    const s = (await startQuiz(admin, u.id, BA)) as Active;
    const k1 = (await stored(s.attemptId, 1)).answer_key;
    await answerQuiz(admin, u.id, BA, s.attemptId, 1, k1);
    const again = (await answerQuiz(admin, u.id, BA, s.attemptId, 1, [0])) as Active;
    expect(again.item.position).toBe(2);
    const ahead = (await answerQuiz(admin, u.id, BA, s.attemptId, 9, [0])) as Active;
    expect(ahead.item.position).toBe(2);
    const { data } = await admin.from("quiz_responses").select("position, answer").eq("attempt_id", s.attemptId).in("position", [1, 9]).order("position");
    expect(data).toEqual([{ position: 1, answer: k1 }, { position: 9, answer: null }]);
  });
});

describe("role quiz: the database marks select-all items all-or-nothing", () => {
  it("only the exact key set scores", async () => {
    const u = await applicant("quiz-multi", BA);
    moveToQuiz(u.appId);
    const { data: item } = await admin
      .from("quiz_items")
      .select("id, topic, stem, options, answer_key")
      .eq("role_slug", BA)
      .eq("multi", true)
      .eq("active", true)
      .limit(1)
      .single();
    const key = item!.answer_key as number[];
    const n = (item!.options as string[]).length;
    const extra = [...Array(n).keys()].find((i) => !key.includes(i))!;
    const { data: attempt, error } = await admin
      .from("quiz_attempts")
      .insert({ application_id: u.appId, user_id: u.id, seed: 1, deadline_at: new Date(Date.now() + 60_000).toISOString() })
      .select("id")
      .single();
    if (error) throw error;

    const cases: [number[] | null, boolean][] = [
      [key, true],
      [[...key].reverse(), true],
      [[...key, key[0]!], true], // duplicates collapse
      [key.slice(1), false], // missing one
      [[...key, extra], false], // one extra
      [null, false], // skipped
    ];
    const { error: insErr } = await admin.from("quiz_responses").insert(
      cases.map((_, i) => ({
        attempt_id: attempt!.id,
        position: i + 1,
        item_id: item!.id,
        topic: item!.topic,
        rendered: { stem: item!.stem, options: item!.options, multi: true },
        answer_key: key,
      })),
    );
    if (insErr) throw insErr;

    for (const [i, [answer, expected]] of cases.entries()) {
      const position = i + 1;
      await admin.from("quiz_responses").update({ served_at: new Date().toISOString() }).eq("attempt_id", attempt!.id).eq("position", position);
      const { data, error: upErr } = await admin
        .from("quiz_responses")
        .update({ answer, answered_at: new Date().toISOString() })
        .eq("attempt_id", attempt!.id)
        .eq("position", position)
        .select("correct")
        .single();
      expect(upErr).toBeNull();
      expect(data!.correct, JSON.stringify(answer)).toBe(expected);
    }
  });
});

describe("role quiz: server-side deadline", () => {
  it("rejects late answers and scores only what arrived in time", async () => {
    const u = await applicant("quiz-late", SWE);
    moveToQuiz(u.appId);
    const s = (await startQuiz(admin, u.id, SWE)) as Active;
    const k1 = (await stored(s.attemptId, 1)).answer_key;
    const s2 = (await answerQuiz(admin, u.id, SWE, s.attemptId, 1, k1)) as Active;
    expect(s2.item.position).toBe(2);
    const k2 = (await stored(s.attemptId, 2)).answer_key;

    expire(s.attemptId);

    // Directly, the DB refuses the late answer...
    const late = await admin
      .from("quiz_responses")
      .update({ answer: k2, answered_at: new Date().toISOString() })
      .eq("attempt_id", s.attemptId)
      .eq("position", 2);
    expect(late.error?.message).toMatch(/quiz_deadline_passed/);

    // ...and through the API the attempt is finalised with the on-time answer only.
    const after = await answerQuiz(admin, u.id, SWE, s.attemptId, 2, k2);
    expect(after.status).toBe("done");
    expect((after as Done).result.rawScore).toBe(1);
    const { data: p2 } = await admin.from("quiz_responses").select("answered_at, correct").eq("attempt_id", s.attemptId).eq("position", 2).single();
    expect(p2).toEqual({ answered_at: null, correct: null });
    expect(await application(u.appId)).toEqual({ stage: "quiz", status: "awaiting_review" });
  });

  it("the cron sweep finalises abandoned attempts", async () => {
    const u = await applicant("quiz-abandon", BA);
    moveToQuiz(u.appId);
    const s = (await startQuiz(admin, u.id, BA)) as Active;
    expire(s.attemptId);
    expect(await finaliseExpiredQuizzes(admin)).toBeGreaterThanOrEqual(1);
    const { data } = await admin.from("quiz_attempts").select("submitted_at, raw_score, pct, below_flag").eq("id", s.attemptId).single();
    expect(data!.submitted_at).not.toBeNull();
    expect(data).toMatchObject({ raw_score: 0, pct: 0, below_flag: true });
    expect(await application(u.appId)).toEqual({ stage: "quiz", status: "awaiting_review" });
  });
});

describe("role quiz: RLS", () => {
  it("candidates cannot read or change quiz items, attempts, responses or stats", async () => {
    const u = await applicant("quiz-rls", SWE);
    moveToQuiz(u.appId);
    const s = (await startQuiz(admin, u.id, SWE)) as Active;

    for (const table of ["quiz_items", "quiz_attempts", "quiz_responses", "quiz_item_stats"]) {
      const { data, error } = await u.client.from(table).select("*").limit(5);
      expect(error, table).toBeNull();
      expect(data, table).toEqual([]);
      const a = await anon().from(table).select("*").limit(1);
      expect(a.error ?? (a.data?.length === 0 ? "empty" : null), `anon ${table}`).toBeTruthy();
    }

    const write = await u.client
      .from("quiz_responses")
      .update({ answer: [0], answered_at: new Date().toISOString() })
      .eq("attempt_id", s.attemptId)
      .eq("position", 1)
      .select();
    expect(write.error ?? (write.data?.length === 0 ? "no rows" : null)).toBeTruthy();
    const insert = await u.client.from("quiz_items").insert({
      role_slug: SWE,
      topic: "ops",
      stem: "Injected item?",
      options: ["a", "b", "c", "d"],
      answer_key: [0],
    });
    expect(insert.error).not.toBeNull();
  });
});

describe("role quiz: admin holds and decisions", () => {
  it("a hold at the quiz stage can be released without skipping the quiz", async () => {
    const u = await applicant("quiz-hold", SWE);
    moveToQuiz(u.appId);

    await decide(u.appId, "hold");
    expect(await application(u.appId)).toEqual({ stage: "quiz", status: "awaiting_review" });
    await expect(startQuiz(admin, u.id, SWE)).rejects.toMatchObject({ status: 403 });

    // Releasing the hold keeps the quiz stage (the quiz has not been taken yet).
    await decide(u.appId, "advance");
    expect(await application(u.appId)).toEqual({ stage: "quiz", status: "advanced" });
    expect(await getQuizState(admin, u.id, SWE)).toEqual({ status: "none", canStart: true });
    const s = (await startQuiz(admin, u.id, SWE)) as Active;
    expect(s.status).toBe("active");
    expect(await application(u.appId)).toEqual({ stage: "quiz", status: "in_progress" });

    // A hold and release mid-quiz neither freezes the quiz nor skips the admin review after it.
    await decide(u.appId, "hold");
    const k1 = (await stored(s.attemptId, 1)).answer_key;
    expect(((await answerQuiz(admin, u.id, SWE, s.attemptId, 1, k1)) as Active).item.position).toBe(2);
    await decide(u.appId, "advance");
    expect(await application(u.appId)).toEqual({ stage: "quiz", status: "advanced" });
    expire(s.attemptId);
    expect(await getQuizState(admin, u.id, SWE)).toMatchObject({ status: "done", result: { rawScore: 1 } });
    expect(await application(u.appId)).toEqual({ stage: "quiz", status: "awaiting_review" });

    // Once the quiz is submitted, advancing moves on to the first work assessment.
    await decide(u.appId, "advance");
    expect(await application(u.appId)).toEqual({ stage: "work_1", status: "advanced" });
  });

  it("a rejection freezes an in-progress quiz: it is finalised and nothing more is served", async () => {
    const u = await applicant("quiz-reject", BA);
    moveToQuiz(u.appId);
    const s = (await startQuiz(admin, u.id, BA)) as Active;
    const k1 = (await stored(s.attemptId, 1)).answer_key;
    await answerQuiz(admin, u.id, BA, s.attemptId, 1, k1); // serves position 2

    await decide(u.appId, "reject");
    expect(await answerQuiz(admin, u.id, BA, s.attemptId, 2, [0])).toEqual({ status: "closed" });
    expect(await getQuizState(admin, u.id, BA)).toEqual({ status: "closed" });
    expect(await startQuiz(admin, u.id, BA)).toEqual({ status: "closed" });

    const { data: row } = await admin.from("quiz_attempts").select("submitted_at, raw_score").eq("id", s.attemptId).single();
    expect(row!.submitted_at).not.toBeNull();
    expect(row!.raw_score).toBe(1);
    const { data: served } = await admin
      .from("quiz_responses")
      .select("position, answered_at")
      .eq("attempt_id", s.attemptId)
      .not("served_at", "is", null)
      .order("position");
    expect(served!.map((r) => r.position)).toEqual([1, 2]);
    expect(served![1]!.answered_at).toBeNull();
    expect(await application(u.appId)).toEqual({ stage: "quiz", status: "rejected" });
  });
});

describe("role quiz: robustness", () => {
  it("an attempt with no questions is never scored: it is voided and rebuilt", async () => {
    const u = await applicant("quiz-empty", SWE);
    moveToQuiz(u.appId);
    const empty = await emptyAttempt(u.appId, u.id);

    // Fresh: treated as still being built.
    await expect(getQuizState(admin, u.id, SWE)).rejects.toMatchObject({ status: 409 });
    // Stale: voided, and Start builds a complete new attempt.
    age(empty, 60);
    const s = (await startQuiz(admin, u.id, SWE)) as Active;
    expect(s.status).toBe("active");
    expect(s.attemptId).not.toBe(empty);
    const { count } = await admin.from("quiz_responses").select("position", { count: "exact", head: true }).eq("attempt_id", s.attemptId);
    expect(count).toBe(15);

    // Expired with no questions: the sweep removes it instead of recording 0%.
    const v = await applicant("quiz-empty-expired", BA);
    moveToQuiz(v.appId);
    const gone = await emptyAttempt(v.appId, v.id);
    expire(gone);
    expect(await finaliseExpiredQuizzes(admin, { applicationId: v.appId })).toBe(0);
    const { data: left } = await admin.from("quiz_attempts").select("id").eq("application_id", v.appId);
    expect(left).toEqual([]);
    expect(await application(v.appId)).toEqual({ stage: "quiz", status: "in_progress" });
    expect(await getQuizState(admin, v.id, BA)).toEqual({ status: "none", canStart: true });
  });

  it("concurrent starts share one attempt, and a double-sent answer is recorded once", async () => {
    const u = await applicant("quiz-race", SWE);
    moveToQuiz(u.appId, "advanced");
    const starts = (await Promise.all([1, 2, 3].map(() => startQuiz(admin, u.id, SWE)))) as Active[];
    expect(new Set(starts.map((s) => s.attemptId)).size).toBe(1);
    for (const s of starts) expect(s.item.position).toBe(1);
    const id = starts[0]!.attemptId;
    const { data: attempts } = await admin.from("quiz_attempts").select("id").eq("application_id", u.appId);
    expect(attempts).toHaveLength(1);
    expect(await application(u.appId)).toEqual({ stage: "quiz", status: "in_progress" });

    const k1 = (await stored(id, 1)).answer_key;
    const answers = (await Promise.all([1, 2, 3].map(() => answerQuiz(admin, u.id, SWE, id, 1, k1)))) as Active[];
    for (const a of answers) expect(a.item.position).toBe(2);
    const { data: served } = await admin
      .from("quiz_responses")
      .select("position, correct")
      .eq("attempt_id", id)
      .not("served_at", "is", null)
      .order("position");
    expect(served).toEqual([
      { position: 1, correct: true },
      { position: 2, correct: null },
    ]);
  });
});

describe("role quiz: API routes", () => {
  const params = (role: string) => ({ params: Promise.resolve({ role }) });
  const get = () => new Request("http://localhost/api/quiz/x/state");
  const post = (body: unknown) =>
    new Request("http://localhost/api/quiz/x/next", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("need a signed-in user", async () => {
    signIn(anon());
    expect((await startRoute(post({}), params(SWE))).status).toBe(401);
    expect((await stateRoute(get(), params(SWE))).status).toBe(401);
    const next = await nextRoute(post({ attemptId: crypto.randomUUID(), position: 1, answer: [0] }), params(SWE));
    expect(next.status).toBe(401);
  });

  it("validate the role and the body, keep attempts per role, and never send answer keys", async () => {
    const u = await applicant("quiz-api", SWE);
    const { data: baApp, error } = await u.client.rpc("apply_to_role", { p_slug: BA });
    if (error) throw error;
    moveToQuiz(u.appId);
    moveToQuiz(baApp as string);
    signIn(u.client);

    expect((await startRoute(post({}), params("Not A Role!"))).status).toBe(404);
    expect((await stateRoute(get(), params("Not A Role!"))).status).toBe(404);
    expect((await startRoute(post({}), params("no-such-role"))).status).toBe(404);

    const started = await startRoute(post({}), params(SWE));
    expect(started.status).toBe(200);
    const body = (await started.json()) as Active;
    expect(body.status).toBe("active");
    expect(JSON.stringify(body)).not.toMatch(/answer_?key|item_?id|seed/i);
    const state = (await (await stateRoute(get(), params(SWE))).json()) as Active;
    expect(state).toMatchObject({ status: "active", attemptId: body.attemptId, item: { position: 1 } });

    const bad: unknown[] = [
      "not json",
      {},
      { attemptId: "not-a-uuid", position: 1, answer: [0] },
      { attemptId: body.attemptId, position: 0, answer: [0] },
      { attemptId: body.attemptId, position: 16, answer: [0] },
      { attemptId: body.attemptId, position: 1, answer: [5] },
      { attemptId: body.attemptId, position: 1, answer: [0, 1, 2, 3, 4, 0] },
      { attemptId: body.attemptId, position: 1.5, answer: [0] },
    ];
    for (const b of bad) expect((await nextRoute(post(b), params(SWE))).status, JSON.stringify(b)).toBe(400);

    // The SWE attempt id posted to the BA route (where the user also has an attempt) is not found.
    expect((await startRoute(post({}), params(BA))).status).toBe(200);
    expect((await nextRoute(post({ attemptId: body.attemptId, position: 1, answer: [0] }), params(BA))).status).toBe(404);
    const { data: untouched } = await admin.from("quiz_responses").select("answered_at").eq("attempt_id", body.attemptId).eq("position", 1).single();
    expect(untouched!.answered_at).toBeNull();

    const k1 = (await stored(body.attemptId, 1)).answer_key;
    const next = await nextRoute(post({ attemptId: body.attemptId, position: 1, answer: k1 }), params(SWE));
    expect(next.status).toBe(200);
    const after = (await next.json()) as Active;
    expect(after.item.position).toBe(2);
    expect(JSON.stringify(after)).not.toMatch(/answer_?key|correct/i);
  });

  it("the sweep route needs the cron secret", async () => {
    const url = "http://localhost/api/quiz/finalise-expired";
    expect((await sweepRoute(new Request(url))).status).toBe(401);
    expect((await sweepRoute(new Request(url, { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);

    const u = await applicant("quiz-sweep", SWE);
    moveToQuiz(u.appId);
    const s = (await startQuiz(admin, u.id, SWE)) as Active;
    expire(s.attemptId);
    const ok = await sweepRoute(new Request(url, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { finalised: number }).finalised).toBeGreaterThanOrEqual(1);
    expect(await application(u.appId)).toEqual({ stage: "quiz", status: "awaiting_review" });
  });
});

describe("admin quiz bank actions", () => {
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

  it("refuse anyone who is not an admin", async () => {
    const u = await newUser("quiz-bank-candidate");
    signIn(u.client);
    const { data: item } = await admin.from("quiz_items").select("id, active").eq("role_slug", SWE).eq("active", true).limit(1).single();
    expect(await outcome(toggleQuizItem(form({ id: item!.id, active: "false", role: SWE })))).toBe("404");
    const stem = `Candidate-added item ${Date.now()}?`;
    expect(
      await outcome(addQuizItem(form({ role_topic: `${SWE}:ops`, stem, options: "a1\nb2\nc3\nd4", correct: "1" }))),
    ).toBe("404");
    const { data: still } = await admin.from("quiz_items").select("active").eq("id", item!.id).single();
    expect(still!.active).toBe(true);
    const { count } = await admin.from("quiz_items").select("id", { count: "exact", head: true }).eq("stem", stem);
    expect(count).toBe(0);
  });

  it("won't deactivate below the blueprint floor, and validates new items", async () => {
    signIn(boss.client);
    const { data: ops } = await admin.from("quiz_items").select("id").eq("role_slug", SWE).eq("topic", "ops").eq("active", true);
    const [keep, ...others] = ops!.map((r) => r.id as string);
    expect(others.length).toBeGreaterThan(0);
    try {
      const { error } = await admin.from("quiz_items").update({ active: false }).in("id", others);
      if (error) throw error;
      // Ops needs 1 item per attempt, so the last active one stays.
      const refused = await outcome(toggleQuizItem(form({ id: keep!, active: "false", role: SWE, topic: "ops" })));
      expect(msg(refused, "error")).toMatch(/needs at least 1 active/);
      const { data: kept } = await admin.from("quiz_items").select("active").eq("id", keep!).single();
      expect(kept!.active).toBe(true);
      // Activating another one works, and then the first may go.
      expect(msg(await outcome(toggleQuizItem(form({ id: others[0]!, active: "true", role: SWE }))), "ok")).toBe("Item activated.");
      expect(msg(await outcome(toggleQuizItem(form({ id: keep!, active: "false", role: SWE }))), "ok")).toBe("Item deactivated.");
    } finally {
      await admin.from("quiz_items").update({ active: true }).in("id", [keep!, ...others]);
    }

    const stem = `Which HTTP status code means "Not Found"? (test ${Date.now()})`;
    const base = { role_topic: `${SWE}:web_security`, stem, options: "200\n301\n404\n500" };
    const bad = await outcome(addQuizItem(form({ ...base, correct: "9" })));
    expect(msg(bad, "error")).toMatch(/option numbers from 1 to 4/);
    const positional = await outcome(addQuizItem(form({ ...base, options: "200\n301\n404\nAll of the above", correct: "3" })));
    expect(msg(positional, "error")).toMatch(/shuffled/);
    const added = await outcome(addQuizItem(form({ ...base, correct: "3" })));
    expect(msg(added, "ok")).toMatch(/Item added/);
    const { data: row } = await admin.from("quiz_items").select("id, answer_key, multi, active, topic").eq("stem", stem).single();
    expect(row).toMatchObject({ answer_key: [2], multi: false, active: true, topic: "web_security" });
    await admin.from("quiz_items").delete().eq("id", row!.id);
  });
});
