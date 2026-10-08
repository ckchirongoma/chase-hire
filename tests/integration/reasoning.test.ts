import { beforeAll, describe, expect, it } from "vitest";
import { answer, finaliseExpired, getState, startAttempt, type ReasoningState } from "@/lib/server/reasoning";
import { consent, fakeParsedCv, newUser, psql, service } from "../helpers/local";

type Active = Extract<ReasoningState, { status: "active" }>;
const admin = service();

async function readyCandidate(tag: string) {
  const u = await newUser(tag);
  await consent(u.client);
  await fakeParsedCv(u.id);
  return u;
}

async function keyFor(attemptId: string, position: number) {
  const { data } = await admin.from("reasoning_responses").select("answer_key").eq("attempt_id", attemptId).eq("position", position).single();
  return data!.answer_key as number;
}

describe("reasoning assessment flow (server-side)", () => {
  let user: Awaited<ReturnType<typeof readyCandidate>>;
  beforeAll(async () => {
    user = await readyCandidate("reasoning");
  });

  it("refuses to start without a parsed CV", async () => {
    const u = await newUser("nocv");
    await expect(startAttempt(admin, u.id)).rejects.toThrow(/Upload your CV/);
  });

  it("serves 30 items one at a time, never exposing the key, and scores server-side", async () => {
    let state = (await startAttempt(admin, user.id)) as Active;
    expect(state.status).toBe("active");
    expect(state.item.position).toBe(1);
    expect(state.item.options).toHaveLength(5);
    expect(JSON.stringify(state)).not.toMatch(/answer_?[Kk]ey|answerIndex/);

    // The DB clock set a 15-minute deadline.
    const { data: attempt } = await admin.from("reasoning_attempts").select("started_at, deadline_at").eq("id", state.attemptId).single();
    expect(new Date(attempt!.deadline_at).getTime() - new Date(attempt!.started_at).getTime()).toBe(15 * 60 * 1000);

    // Starting again resumes the same attempt and item.
    const resumed = (await startAttempt(admin, user.id)) as Active;
    expect(resumed.attemptId).toBe(state.attemptId);
    expect(resumed.item.position).toBe(1);

    // Answer 10 correctly, 10 wrong, skip 10.
    for (let pos = 1; pos <= 30; pos++) {
      expect(state.item.position).toBe(pos);
      const key = await keyFor(state.attemptId, pos);
      const choice = pos <= 10 ? key : pos <= 20 ? (key + 1) % 5 : null;
      const next = await answer(admin, user.id, state.attemptId, pos, choice);
      if (pos < 30) state = next as Active;
      else {
        expect(next.status).toBe("done");
        if (next.status === "done") {
          expect(next.result.rawScore).toBe(10);
          expect(next.result.stars).toBeGreaterThanOrEqual(1);
          expect(next.result.normVersion).toBe("provisional-normal-v1");
        }
      }
    }
  });

  it("ignores a duplicate answer for an already-answered position (no back-navigation)", async () => {
    const u = await readyCandidate("dup");
    const s = (await startAttempt(admin, u.id)) as Active;
    await answer(admin, u.id, s.attemptId, 1, 0);
    const again = (await answer(admin, u.id, s.attemptId, 1, 4)) as Active;
    expect(again.item.position).toBe(2);
    const { data } = await admin.from("reasoning_responses").select("answer").eq("attempt_id", s.attemptId).eq("position", 1).single();
    expect(data!.answer).toBe(0);
  });

  it("DB refuses changing an answer, answering unserved items, or answering after the deadline", async () => {
    const u = await readyCandidate("guards");
    const s = (await startAttempt(admin, u.id)) as Active;
    await answer(admin, u.id, s.attemptId, 1, 1);

    const change = await admin.from("reasoning_responses").update({ answer: 2, answered_at: new Date().toISOString() }).eq("attempt_id", s.attemptId).eq("position", 1);
    expect(change.error?.message).toMatch(/already_answered/);

    const unserved = await admin.from("reasoning_responses").update({ answer: 2, answered_at: new Date().toISOString() }).eq("attempt_id", s.attemptId).eq("position", 10);
    expect(unserved.error?.message).toMatch(/not_served/);

    // Simulate the clock running out (deadline is otherwise immutable).
    psql(`alter table public.reasoning_attempts disable trigger reasoning_attempts_guard;
          update public.reasoning_attempts set started_at = now() - interval '20 minutes', deadline_at = now() - interval '5 minutes' where id = '${s.attemptId}';
          alter table public.reasoning_attempts enable trigger reasoning_attempts_guard;`);
    const late = await admin.from("reasoning_responses").update({ answer: 2, answered_at: new Date().toISOString() }).eq("attempt_id", s.attemptId).eq("position", 2);
    expect(late.error?.message).toMatch(/deadline_passed/);

    // The API scores what was answered in time; the attempt is then final.
    const state = await getState(admin, u.id);
    expect(state.status).toBe("done");
    const tamper = await admin.from("reasoning_attempts").update({ raw_score: 30 }).eq("id", s.attemptId);
    expect(tamper.error?.message).toMatch(/already_submitted/);
  });

  it("allows one online attempt per 90 days", async () => {
    await expect(startAttempt(admin, user.id)).rejects.toThrow(/once every 90 days/);
    await expect(getState(admin, user.id)).resolves.toMatchObject({ status: "done" });
    const direct = await admin.from("reasoning_attempts").insert({ user_id: user.id, seed: 2, deadline_at: new Date().toISOString() });
    expect(direct.error?.message).toMatch(/retake_too_soon/);
  });

  it("cron finalises abandoned attempts", async () => {
    const u = await readyCandidate("abandon");
    const s = (await startAttempt(admin, u.id)) as Active;
    psql(`alter table public.reasoning_attempts disable trigger reasoning_attempts_guard;
          update public.reasoning_attempts set started_at = now() - interval '20 minutes', deadline_at = now() - interval '5 minutes' where id = '${s.attemptId}';
          alter table public.reasoning_attempts enable trigger reasoning_attempts_guard;`);
    expect(await finaliseExpired(admin)).toBeGreaterThanOrEqual(1);
    const { data } = await admin.from("reasoning_attempts").select("submitted_at, raw_score, stars").eq("id", s.attemptId).single();
    expect(data!.submitted_at).not.toBeNull();
    expect(data!.raw_score).toBe(0);
    expect(data!.stars).toBe(1);
  });
});
