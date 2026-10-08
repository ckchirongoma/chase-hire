import { describe, expect, it } from "vitest";
import { applyTurn, canProbe, labelFor, nextQuestionIndex, openScript, unusedProbes } from "@/lib/interview/engine";
import {
  HARD_LIMIT_MINUTES,
  MAX_FOLLOWUPS_OPENER,
  MAX_FOLLOWUPS_PER_TOPIC,
  NO_FOLLOWUP_MS,
  OFF_SCRIPT_REPLY,
  PROBES,
  ROLE_QUESTION_REPLY,
  SKIP_TO_LOGISTICS_MS,
  SKIP_TO_SITUATIONAL_MS,
  openingQuestion,
} from "@/lib/interview/script";
import type { FollowupTarget, InterviewPlan, Progress, TurnDecision } from "@/lib/interview/types";

const WARMUP_QUESTION = openingQuestion("AI-native Business Analyst");

const plan: InterviewPlan = {
  v: 2,
  cvId: null,
  role: { slug: "business-analyst", title: "AI-native Business Analyst" },
  claims: ["c1", "c2", "c3"].map((id) => ({ id, text: `claim ${id}`, kind: "claim", why: "filler", roleTitle: null, employer: null })),
  questions: [
    { no: 1, step: "warmup", claimId: null, text: WARMUP_QUESTION },
    { no: 2, step: "claim", claimId: "c1", text: "Q c1" },
    { no: 3, step: "claim", claimId: "c2", text: "Q c2" },
    { no: 4, step: "claim", claimId: "c3", text: "Q c3" },
    { no: 5, step: "situational", claimId: null, text: "Q sit" },
    { no: 6, step: "logistics", claimId: null, text: "Q log" },
  ],
  probes: [...PROBES],
  selection: { via: "none", model: null, ms: null, impressive: null, closest: null },
};

const answer = (target: FollowupTarget | null = null, text = `Follow-up on ${target}?`): TurnDecision => ({
  kind: "answer",
  followup: target ? { text, target, via: "llm" } : null,
});

function advance(p: Progress, d: TurnDecision, remainingMs?: number) {
  return applyTurn(plan, p, d, { remainingMs });
}

describe("openScript", () => {
  it("opens with the intro (voice by default: time, be specific, tab rule) and question 1", () => {
    const { progress, messages } = openScript(plan);
    expect(messages.map((m) => m.step)).toEqual(["intro", "warmup"]);
    expect(messages[0].content).toMatch(/25–30 minutes/);
    expect(messages[0].content).toContain(`hard limit of ${HARD_LIMIT_MINUTES}`);
    expect(messages[0].content).toMatch(/specific/);
    expect(messages[0].content).toMatch(/Record/);
    expect(messages[0].content).toMatch(/locks it/);
    expect(messages[0].content).not.toMatch(/\d+ questions/);
    expect(messages[1].content).toBe(WARMUP_QUESTION);
    expect(messages.map((m) => m.meta.idx)).toEqual([0, 1]);
    expect(progress).toMatchObject({ v: 2, qIdx: 0, turn: 0, msgCount: 2, done: false, probesAsked: [] });
  });

  it("tells a typed-mode candidate that paste is off instead of how to record", () => {
    const { messages } = openScript(plan, "typed");
    expect(messages[0].content).toMatch(/type your answers/);
    expect(messages[0].content).not.toMatch(/Record/);
  });
});

describe("applyTurn", () => {
  it("moves through the main questions and completes after logistics", () => {
    let { progress } = openScript(plan);
    const asked: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = advance(progress, answer());
      expect(r.progress.turn).toBe(i + 1);
      expect(r.skipped).toBe(0);
      asked.push(...r.messages.map((m) => m.content));
      progress = r.progress;
      if (i < 5) expect(r.done).toBe(false);
      else {
        expect(r.done).toBe(true);
        expect(r.messages).toEqual([]);
        expect(r.progress.done).toBe(true);
      }
    }
    expect(asked).toEqual(["Q c1", "Q c2", "Q c3", "Q sit", "Q log"]);
    expect(() => advance(progress, answer())).toThrow(/finished/);
  });

  it("assigns message order indexes after the candidate's message", () => {
    const { progress } = openScript(plan);
    const r = advance(progress, answer());
    expect(r.candidateIdx).toBe(2);
    expect(r.messages[0].meta.idx).toBe(3);
    expect(r.progress.msgCount).toBe(4);
  });

  it("asks the supplied follow-up after a topic answer, up to the per-topic cap, then moves on", () => {
    let { progress } = openScript(plan);
    progress = advance(progress, answer()).progress; // warm-up → c1
    expect(progress.current).toMatchObject({ step: "claim", claimId: "c1" });
    expect(canProbe(plan, progress)).toBe(true);

    const targets: FollowupTarget[] = ["specifics", "ownership", "failure", "tradeoff"];
    expect(targets).toHaveLength(MAX_FOLLOWUPS_PER_TOPIC);
    let r = advance(progress, answer("specifics", "You said 40 minutes. What made it slow?"));
    expect(r.messages[0]).toMatchObject({ step: "probe", claimId: "c1", content: "You said 40 minutes. What made it slow?" });
    expect(r.messages[0].meta).toMatchObject({ probe_key: "specifics", question_no: 2, followup_via: "llm" });
    expect(r.progress.current).toMatchObject({ step: "probe", questionNo: 2, probeKey: "specifics" });
    expect(unusedProbes(plan, r.progress).map((p) => p.key)).toEqual(["ownership", "failure", "tradeoff", "consistency", "ai_use"]);

    for (const t of targets.slice(1)) {
      r = advance(r.progress, answer(t));
      expect(r.messages[0]).toMatchObject({ step: "probe", content: `Follow-up on ${t}?` });
    }
    expect(r.progress.probesAsked).toEqual(targets);
    expect(canProbe(plan, r.progress)).toBe(false);

    // A fifth follow-up is refused: the script moves to the next topic.
    r = advance(r.progress, answer("ai_use"));
    expect(r.messages[0]).toMatchObject({ step: "claim", claimId: "c2", content: "Q c2" });
    expect(r.progress.probesAsked).toEqual([]);
    expect(canProbe(plan, r.progress)).toBe(true);
  });

  it("records whether a follow-up came from the LLM or a template", () => {
    let { progress } = openScript(plan);
    progress = advance(progress, answer()).progress;
    const r = advance(progress, { kind: "answer", followup: { text: PROBES[2].text, target: "failure", via: "template" } });
    expect(r.messages[0].meta).toMatchObject({ probe_key: "failure", followup_via: "template" });
  });

  it("follows up the opening question up to MAX_FOLLOWUPS_OPENER times, never situational or logistics answers", () => {
    const { progress } = openScript(plan);
    expect(canProbe(plan, progress)).toBe(true);
    let p = progress;
    for (let i = 0; i < MAX_FOLLOWUPS_OPENER; i++) {
      const r = advance(p, answer(PROBES[i].key));
      expect(r.messages[0]).toMatchObject({ step: "probe", meta: { question_no: 1 } });
      p = r.progress;
    }
    expect(canProbe(plan, p)).toBe(false);
    expect(advance(p, answer("ai_use")).messages[0].step).toBe("claim");
    const sit: Progress = { ...progress, qIdx: 4, current: { step: "situational", claimId: null, text: "Q sit", questionNo: 5 } };
    expect(canProbe(plan, sit)).toBe(false);
    expect(advance(sit, answer("specifics")).messages[0].step).toBe("logistics");
  });

  it("asks no new follow-ups with less than NO_FOLLOWUP_MS left", () => {
    let { progress } = openScript(plan);
    progress = advance(progress, answer()).progress;
    expect(canProbe(plan, progress, NO_FOLLOWUP_MS)).toBe(true);
    expect(canProbe(plan, progress, NO_FOLLOWUP_MS - 1)).toBe(false);
    // No follow-up; with this little time left the remaining topics are skipped too.
    const r = advance(progress, answer("specifics"), NO_FOLLOWUP_MS - 1);
    expect(r.messages[0]).toMatchObject({ step: "situational" });
    expect(r.progress.probesAsked).toEqual([]);
  });

  it("skips the remaining topics when time is short, so situational and logistics are always reached", () => {
    let { progress } = openScript(plan);
    progress = advance(progress, answer()).progress; // at c1
    const r = advance(progress, answer(), SKIP_TO_SITUATIONAL_MS - 1);
    expect(r.messages[0]).toMatchObject({ step: "situational", content: "Q sit" });
    expect(r.messages[0].meta).toMatchObject({ skipped_for_time: 2 });
    expect(r.skipped).toBe(2);

    const late = advance(progress, answer(), SKIP_TO_LOGISTICS_MS - 1);
    expect(late.messages[0]).toMatchObject({ step: "logistics", content: "Q log" });
    expect(late.skipped).toBe(3);
  });

  it("handles off-script messages: fixed reply + the same question, cursor unchanged", () => {
    let { progress } = openScript(plan);
    progress = advance(progress, answer()).progress;
    const r = advance(progress, { kind: "off_script" });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ step: "redirect", claimId: "c1", content: `${OFF_SCRIPT_REPLY}\n\nQ c1` });
    expect(r.progress).toMatchObject({ qIdx: progress.qIdx, current: progress.current, turn: progress.turn + 1, done: false });

    const q = advance(r.progress, { kind: "role_question" });
    expect(q.messages[0].content).toBe(`${ROLE_QUESTION_REPLY}\n\nQ c1`);
    expect(q.messages[0].meta).toMatchObject({ reason: "role_question" });
    // The real answer then proceeds as normal.
    expect(advance(q.progress, answer()).messages[0].content).toBe("Q c2");
  });

  it("repeats the follow-up (not the topic question) when off-script during a follow-up", () => {
    let { progress } = openScript(plan);
    progress = advance(progress, answer()).progress;
    progress = advance(progress, answer("ai_use", "Which parts did Copilot write?")).progress;
    const r = advance(progress, { kind: "off_script" });
    expect(r.messages[0].content).toBe(`${OFF_SCRIPT_REPLY}\n\nWhich parts did Copilot write?`);
  });
});

describe("nextQuestionIndex", () => {
  it("is the next index without a clock or with plenty of time", () => {
    expect(nextQuestionIndex(plan, 1)).toBe(2);
    expect(nextQuestionIndex(plan, 1, 20 * 60_000)).toBe(2);
    expect(nextQuestionIndex(plan, 5, 0)).toBe(6); // past the end = finished
  });

  it("never skips backwards, and only skips topics (not the situational question) before logistics", () => {
    expect(nextQuestionIndex(plan, 4, SKIP_TO_SITUATIONAL_MS - 1)).toBe(5);
    expect(nextQuestionIndex(plan, 3, SKIP_TO_SITUATIONAL_MS - 1)).toBe(4);
    expect(nextQuestionIndex(plan, 0, SKIP_TO_LOGISTICS_MS - 1)).toBe(5);
  });
});

describe("labelFor", () => {
  it("labels main questions and follow-ups only", () => {
    expect(labelFor("claim", { question_no: 3 }, 6)).toBe("Question 3 of 6");
    expect(labelFor("probe", { question_no: 3 }, 6)).toBe("Follow-up");
    expect(labelFor("intro", {}, 6)).toBeNull();
    expect(labelFor("redirect", { question_no: 3 }, 6)).toBeNull();
  });
});
