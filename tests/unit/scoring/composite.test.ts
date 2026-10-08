import { describe, expect, it } from "vitest";
import {
  execCommsScore,
  finalComposite,
  liveComposite,
  liveParts,
  PRE_LIVE_WEIGHTS,
  LIVE_WEIGHTS,
  preLiveComposite,
  rubricTo100,
  weightedComposite,
} from "@/lib/scoring/composite";

describe("weights (docs/09 §2)", () => {
  it("each role's pre-live and live weights sum to 100", () => {
    for (const w of Object.values(PRE_LIVE_WEIGHTS)) expect(Object.values(w).reduce((a, b) => a + b, 0)).toBe(100);
    for (const w of Object.values(LIVE_WEIGHTS)) expect(Object.values(w).reduce((a, b) => a + (b ?? 0), 0)).toBe(100);
  });

  it("SWE weights work 1 at 35% and work 2 at 25%; BA 30/30", () => {
    expect(PRE_LIVE_WEIGHTS["software-engineer"]).toMatchObject({ work_1: 35, work_2: 25 });
    expect(PRE_LIVE_WEIGHTS["business-analyst"]).toMatchObject({ work_1: 30, work_2: 30 });
  });
});

describe("preLiveComposite", () => {
  it("is the weighted mean when every stage is present", () => {
    const r = preLiveComposite("software-engineer", { reasoning: 80, interview: 60, quiz: 70, work_1: 50, work_2: 90 });
    // (80*10 + 60*15 + 70*15 + 50*35 + 90*25) / 100
    expect(r).toEqual({ score: 67.5, coverage: 1, missing: [] });
  });

  it("renormalises over the stages present and reports coverage and what is missing", () => {
    const r = preLiveComposite("business-analyst", { reasoning: 90, interview: 50, quiz: null });
    expect(r.score).toBe(66); // (90*10 + 50*15) / 25
    expect(r.coverage).toBe(0.25);
    expect(r.missing).toEqual(["quiz", "work_1", "work_2"]);
  });

  it("ignores out-of-range or non-numeric parts and returns null with nothing present", () => {
    expect(preLiveComposite("business-analyst", { reasoning: 120, interview: Number.NaN, quiz: -1 })).toEqual({
      score: null,
      coverage: 0,
      missing: ["reasoning", "interview", "quiz", "work_1", "work_2"],
    });
  });

  it("falls back to the BA weights for a role without its own", () => {
    expect(preLiveComposite("data-engineer", { work_1: 100, work_2: 0 }).score).toBe(50);
  });
});

describe("live and final composites", () => {
  it("averages submitted raters per kind and ignores drafts", () => {
    const parts = liveParts([
      { kind: "panel_interview", total: 80, submitted: true },
      { kind: "panel_interview", total: 60, submitted: true },
      { kind: "panel_interview", total: 0, submitted: false },
      { kind: "live_defence", total: 50, submitted: true },
    ]);
    expect(parts).toEqual({ panel_interview: 70, live_defence: 50 });
  });

  it("final = 50/50 only when both pre-live and live are complete", () => {
    const pre = preLiveComposite("software-engineer", { reasoning: 80, interview: 60, quiz: 70, work_1: 50, work_2: 90 });
    const live = liveComposite("software-engineer", { panel_interview: 70, live_defence: 50, exec_scenario: 90 });
    expect(live).toEqual({ score: 66, coverage: 1, missing: [] });
    expect(finalComposite(pre, live)).toBe(66.8); // (67.5 + 66) / 2, rounded to 1 dp
    const partialLive = liveComposite("software-engineer", { panel_interview: 70 });
    expect(finalComposite(pre, partialLive)).toBeNull();
    const partialPre = preLiveComposite("software-engineer", { reasoning: 80 });
    expect(finalComposite(partialPre, live)).toBeNull();
  });

  it("BA live uses elicitation, SWE uses the exec scenario", () => {
    expect(liveComposite("business-analyst", { panel_interview: 100, live_defence: 100, exec_scenario: 0 }).missing).toEqual(["live_elicitation"]);
    expect(liveComposite("software-engineer", { live_elicitation: 100 }).score).toBeNull();
  });
});

describe("rubric mapping and executive communication", () => {
  it("maps 1–5 linearly onto 0–100", () => {
    expect([1, 2, 3, 4, 5].map(rubricTo100)).toEqual([0, 25, 50, 75, 100]);
  });

  it("is the mean of every exec-comms instance across stages", () => {
    expect(execCommsScore([3, 5, null, 4])).toEqual({ score: 75, n: 3 });
    expect(execCommsScore([])).toEqual({ score: null, n: 0 });
    expect(execCommsScore([0, 6])).toEqual({ score: null, n: 0 });
  });

  it("weightedComposite skips zero weights", () => {
    expect(weightedComposite({ a: 0, b: 1 }, { a: 10, b: 20 })).toEqual({ score: 20, coverage: 1, missing: [] });
  });
});
