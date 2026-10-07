import { describe, expect, it } from "vitest";
import { applyTurn, canProbe, labelFor, openScript, unusedProbes } from "@/lib/interview/engine";
import { CLAIMS_PER_INTERVIEW, OFF_SCRIPT_REPLY, PROBES, ROLE_QUESTION_REPLY, TOTAL_QUESTIONS, WARMUP_QUESTION } from "@/lib/interview/script";
import type { InterviewPlan, ProbeKey, Progress, TurnDecision } from "@/lib/interview/types";

const plan: InterviewPlan = {
  v: 1,
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

const answer = (probeKey: ProbeKey | null = null): TurnDecision => ({ kind: "answer", probeKey });

function advance(p: Progress, d: TurnDecision) {
  return applyTurn(plan, p, d);
}

describe("openScript", () => {
  it("opens with the intro (6 questions, be specific) and question 1", () => {
    const { progress, messages } = openScript(plan);
    expect(messages.map((m) => m.step)).toEqual(["intro", "warmup"]);
    expect(messages[0].content).toMatch(/6 questions/);
    expect(messages[0].content).toMatch(/specific/);
    expect(messages[1].content).toBe(WARMUP_QUESTION);
    expect(messages.map((m) => m.meta.idx)).toEqual([0, 1]);
    expect(progress).toMatchObject({ qIdx: 0, turn: 0, msgCount: 2, done: false, probesAsked: [] });
    expect(TOTAL_QUESTIONS).toBe(1 + CLAIMS_PER_INTERVIEW + 2);
  });
});

describe("applyTurn", () => {
  it("moves through the 6 questions and completes after logistics", () => {
    let { progress } = openScript(plan);
    const asked: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = advance(progress, answer());
      expect(r.progress.turn).toBe(i + 1);
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

  it("asks a chosen probe after a claim answer, at most 2 per claim, then moves on", () => {
    let { progress } = openScript(plan);
    progress = advance(progress, answer()).progress; // warm-up → c1
    expect(progress.current).toMatchObject({ step: "claim", claimId: "c1" });
    expect(canProbe(plan, progress)).toBe(true);

    let r = advance(progress, answer("what_broke"));
    expect(r.messages[0]).toMatchObject({ step: "probe", claimId: "c1", content: PROBES[1].text });
    expect(r.messages[0].meta).toMatchObject({ probe_key: "what_broke", question_no: 2 });
    expect(r.progress.current).toMatchObject({ step: "probe", questionNo: 2, probeKey: "what_broke" });
    expect(unusedProbes(plan, r.progress).map((p) => p.key)).toEqual(["hardest_decision", "differently", "ai_tools"]);

    r = advance(r.progress, answer("hardest_decision"));
    expect(r.messages[0]).toMatchObject({ step: "probe", content: PROBES[0].text });
    expect(canProbe(plan, r.progress)).toBe(false);

    // A third probe is refused: the script moves to the next claim.
    r = advance(r.progress, answer("ai_tools"));
    expect(r.messages[0]).toMatchObject({ step: "claim", claimId: "c2", content: "Q c2" });
    expect(r.progress.probesAsked).toEqual([]);
    expect(canProbe(plan, r.progress)).toBe(true);
  });

  it("never repeats a probe on the same claim and ignores unknown keys", () => {
    let { progress } = openScript(plan);
    progress = advance(progress, answer()).progress;
    const r1 = advance(progress, answer("what_broke"));
    const r2 = advance(r1.progress, answer("what_broke"));
    expect(r2.messages[0]).toMatchObject({ step: "claim", claimId: "c2" });
  });

  it("does not probe the warm-up, situational or logistics answers", () => {
    const { progress } = openScript(plan);
    expect(canProbe(plan, progress)).toBe(false);
    const r = advance(progress, answer("what_broke"));
    expect(r.messages[0].step).toBe("claim");
    const sit: Progress = { ...progress, qIdx: 4, current: { step: "situational", claimId: null, text: "Q sit", questionNo: 5 } };
    expect(advance(sit, answer("what_broke")).messages[0].step).toBe("logistics");
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

  it("repeats a probe (not the claim question) when off-script during a probe", () => {
    let { progress } = openScript(plan);
    progress = advance(progress, answer()).progress;
    progress = advance(progress, answer("ai_tools")).progress;
    const r = advance(progress, { kind: "off_script" });
    expect(r.messages[0].content).toBe(`${OFF_SCRIPT_REPLY}\n\n${PROBES[3].text}`);
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
