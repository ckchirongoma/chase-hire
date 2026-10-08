import { describe, expect, it } from "vitest";
import {
  adjustFaultCredit,
  aggregateParent,
  answerKeyCoverage,
  consolidateMapping,
  createLimiter,
  deployScoreFromHarness,
  elicitationYield,
  faultPointsToScore,
  gapRecall,
  importScoreFromHarness,
  majorityFlags,
  ReferenceGrade,
  shareToScore,
  stageScore,
  storiesScoreFromHarness,
  type MappingItem,
} from "@/lib/grading";
import { formatBaseline, parseBaseline } from "@/lib/grading/baseline";
import { GAP_KEY, HIDDEN_FACTS } from "@/lib/grading/rubrics/ba-part1";
import { FAULT_KEY } from "@/lib/grading/rubrics/swe-test1";
import { ARCH_KEY, RED_FLAGS } from "@/lib/grading/rubrics/swe-test2";

const m = (id: string, status: MappingItem["status"]): MappingItem => ({ id, status, quote: status === "missing" ? "" : `q ${id}` });

describe("gap recall (docs/06: Σ weight × credit ÷ 40)", () => {
  it("scores the full key as 5 and nothing as 1", () => {
    expect(gapRecall(Object.fromEntries(GAP_KEY.map((g) => [g.id, 1])), GAP_KEY)).toEqual({ points: 40, max: 40, recall: 1, score: 5 });
    expect(gapRecall({}, GAP_KEY)).toEqual({ points: 0, max: 40, recall: 0, score: 1 });
  });

  it("counts partial as half and divides by 40, not 39", () => {
    // Critical gaps found (5 × 3 = 15), D03 partial (2 × 0.5 = 1): 16 of 40.
    const r = gapRecall({ D01: 1, D02: 1, D05: 1, D14: 1, D23: 1, D03: 0.5 }, GAP_KEY);
    expect(r).toEqual({ points: 16, max: 40, recall: 0.4, score: 2.6 });
  });

  it("takes the per-gap median across samples, treating an unmentioned gap as missing", () => {
    const samples = [
      [m("D01", "found"), m("D03", "partial"), m("D04", "found")],
      [m("D01", "found"), m("D03", "found")],
      [m("D01", "partial"), m("D03", "missing"), m("D04", "found"), m("XX9", "found")],
    ];
    const cons = consolidateMapping(samples, ["D01", "D03", "D04", "D05"]);
    expect(cons.map((c) => [c.id, c.credit, c.status])).toEqual([
      ["D01", 1, "found"],
      ["D03", 0.5, "partial"],
      ["D04", 1, "found"],
      ["D05", 0, "missing"],
    ]);
    expect(cons[1].perSample).toEqual(["partial", "found", "missing"]);
    expect(cons[0].quote).toBe("q D01");
  });

  it("normalises judge output: upper-case ids, lower-case statuses, string red flags", () => {
    const g = ReferenceGrade.parse({
      evidence: [{ quote: "x y z" }],
      rationale: "r",
      score: "3",
      reference_mapping: [{ id: "d01", status: "Found" }, { id: "D02", status: "Not found" }, { id: "D03", status: "partially" }],
      red_flags_triggered: ["Auto_Takedowns"],
      extra_valid_gaps: ["Duplicate MSISDNs"],
    });
    expect(g.reference_mapping).toEqual([
      { id: "D01", status: "found", quote: "" },
      { id: "D02", status: "missing", quote: "" },
      { id: "D03", status: "partial", quote: "" },
    ]);
    expect(g.red_flags_triggered).toEqual([{ id: "auto_takedowns", quote: "" }]);
    expect(g.extra_valid_gaps).toEqual([{ gap: "Duplicate MSISDNs", quote: "" }]);
  });
});

describe("elicitation yield (weights of revealed facts ÷ 30)", () => {
  it("counts each fact once and ignores unknown ids", () => {
    const y = elicitationYield(["H01", "h03", "H01", "H12", "H99"], HIDDEN_FACTS);
    expect(y).toMatchObject({ revealed: ["H01", "H03", "H12"], points: 7, max: 30 });
    expect(y.score).toBeCloseTo(1 + (4 * 7) / 30, 2);
    expect(elicitationYield(HIDDEN_FACTS.map((h) => h.id), HIDDEN_FACTS)).toMatchObject({ points: 30, score: 5 });
    expect(elicitationYield([], HIDDEN_FACTS)).toMatchObject({ points: 0, score: 1 });
  });
});

describe("answer-key coverage (/32) with red-flag caps", () => {
  const all = Object.fromEntries(ARCH_KEY.map((a) => [a.id, 1]));

  it("scores full coverage with no flags as 5", () => {
    expect(answerKeyCoverage(all, ARCH_KEY, [], RED_FLAGS)).toMatchObject({ points: 32, max: 32, coverage: 1, score: 5, capped: {}, criterionCaps: {} });
  });

  it("crawler zeroes A02", () => {
    const r = answerKeyCoverage(all, ARCH_KEY, ["crawler"], RED_FLAGS);
    expect(r.capped).toEqual({ A02: { from: 1, to: 0, flag: "crawler" } });
    expect(r.points).toBe(29);
  });

  it("uploading masters without security zeroes A07", () => {
    const r = answerKeyCoverage(all, ARCH_KEY, ["masters_without_security"], RED_FLAGS);
    expect(r.capped).toEqual({ A07: { from: 1, to: 0, flag: "masters_without_security" } });
    expect(r.points).toBe(30);
  });

  it("accepting automatic takedowns zeroes A04 and caps exec comms at 3", () => {
    const r = answerKeyCoverage(all, ARCH_KEY, ["auto_takedowns"], RED_FLAGS);
    expect(r.capped).toEqual({ A04: { from: 1, to: 0, flag: "auto_takedowns" } });
    expect(r.criterionCaps).toEqual({ exec_comms: 3 });
    expect(r.points).toBe(29);
  });

  it("an unsourced precise price halves A11; all-diagram memos cap the cost model at 2", () => {
    expect(answerKeyCoverage(all, ARCH_KEY, ["unsourced_vendor_price"], RED_FLAGS).points).toBe(31);
    expect(answerKeyCoverage(all, ARCH_KEY, ["diagram_no_numbers"], RED_FLAGS).criterionCaps).toEqual({ cost_model: 2 });
  });

  it("does not raise a credit the judge did not give, and ignores unknown flags", () => {
    const r = answerKeyCoverage({ A01: 1, A04: 0 }, ARCH_KEY, ["auto_takedowns", "made_up"], RED_FLAGS);
    expect(r.capped).toEqual({});
    expect(r.flags).toEqual(["auto_takedowns"]);
    expect(r.points).toBe(3);
    expect(r.score).toBe(shareToScore(3 / 32));
  });

  it("needs a majority of samples to count a red flag", () => {
    expect(majorityFlags([["crawler", "auto_takedowns"], ["auto_takedowns"], []])).toEqual(["auto_takedowns"]);
    expect(majorityFlags([["crawler", "crawler"], [], []])).toEqual([]);
  });
});

describe("SWE Test 1 fault points → doc 09 S1 anchors", () => {
  it("maps < 6 → 1, 10–14 → 3, ≥ 18 → 5 and interpolates linearly between", () => {
    expect(faultPointsToScore(0)).toBe(1);
    expect(faultPointsToScore(5.5)).toBe(1);
    expect(faultPointsToScore(6)).toBe(1);
    expect(faultPointsToScore(8)).toBe(2);
    expect(faultPointsToScore(9)).toBe(2.5);
    expect(faultPointsToScore(10)).toBe(3);
    expect(faultPointsToScore(12)).toBe(3);
    expect(faultPointsToScore(14)).toBe(3);
    expect(faultPointsToScore(16)).toBe(4);
    expect(faultPointsToScore(17)).toBe(4.5);
    expect(faultPointsToScore(18)).toBe(5);
    expect(faultPointsToScore(21)).toBe(5);
  });

  it("weights security faults double for a maximum of 21", () => {
    expect(FAULT_KEY.reduce((s, f) => s + f.weight, 0)).toBe(21);
  });

  it("uses harness results to confirm or contradict a claimed fix", () => {
    expect(adjustFaultCredit(0.5, ["U6"], { U6: true })).toEqual({ credit: 1, reason: expect.stringMatching(/confirms/) });
    expect(adjustFaultCredit(1, ["U6"], { U6: false })).toEqual({ credit: 0.5, reason: expect.stringMatching(/fails/) });
    expect(adjustFaultCredit(0, ["U6"], { U6: true })).toEqual({ credit: 0.5, reason: expect.stringMatching(/does not explain/) });
    expect(adjustFaultCredit(1, ["U4"], { U6: true })).toEqual({ credit: 1, reason: null });
    expect(adjustFaultCredit(0, [], {})).toEqual({ credit: 0, reason: null });
  });

  it("scores S2/S3/S4 from the harness and refuses to score when the deciding checks never ran", () => {
    const pass = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, true]));
    expect(importScoreFromHarness(pass(["M1", "M2", "M3", "M4", "M5", "M6", "M7"]))).toMatchObject({ score: 5, missing: [] });
    expect(importScoreFromHarness({ ...pass(["M1", "M2", "M3", "M6"]), M4: false })).toMatchObject({ score: 3, missing: ["M5", "M7"] });
    expect(importScoreFromHarness({ ...pass(["M1", "M2", "M3", "M6", "M5"]) })).toMatchObject({ score: 4 });
    expect(importScoreFromHarness({ M1: false, M6: true })).toMatchObject({ score: 1 });
    expect(importScoreFromHarness({ M2: true })).toMatchObject({ score: null });
    // R5 does not cover RD-11, so the harness alone stops at 4 and asks a person to confirm.
    expect(storiesScoreFromHarness({ U6: true, U7: true, R5: true })).toMatchObject({ score: 4, confirm: expect.stringMatching(/RD-11/) });
    expect(storiesScoreFromHarness({ U6: true, U7: true, R5: false })).toMatchObject({ score: 4 });
    expect(storiesScoreFromHarness({ U6: true, U7: true, R5: false }).confirm).toBeUndefined();
    expect(storiesScoreFromHarness({ U6: true, U7: false })).toMatchObject({ score: 3 });
    expect(storiesScoreFromHarness({ U6: false, U7: false })).toMatchObject({ score: 1 });
    expect(storiesScoreFromHarness({ U6: true })).toMatchObject({ score: null });
    // The S4 5-anchor needs monitoring + a rollback note, which no check covers: capped at 4 for a person to confirm.
    expect(deployScoreFromHarness({ U1: true, R4: true, R5: true, R6: true, R7: true })).toMatchObject({ score: 4, confirm: expect.stringMatching(/monitoring/) });
    expect(deployScoreFromHarness({ U1: true, R4: true, R5: true, R6: true })).toMatchObject({ score: 4, confirm: expect.any(String) });
    expect(deployScoreFromHarness({ U1: true, R4: true, R5: true, R7: false, R6: false })).toMatchObject({ score: 3.5 });
    expect(deployScoreFromHarness({ U1: true, R4: true, R5: true, R7: false, R6: false }).confirm).toBeUndefined();
    expect(deployScoreFromHarness({ U1: true, R4: true, R7: true })).toMatchObject({ score: 3.5, missing: ["R5", "R6"] });
    expect(deployScoreFromHarness({ U1: false })).toMatchObject({ score: 1 });
    expect(deployScoreFromHarness({ R5: false })).toMatchObject({ score: null, basis: expect.stringMatching(/U1 missing/) });
  });
});

describe("parent aggregation and stage score", () => {
  it("parent = mean of sub finals, max spread, review if any sub needs it or is missing", () => {
    expect(aggregateParent([
      { final: 3, spread: 0, needsHumanReview: false },
      { final: 4, spread: 2, needsHumanReview: true },
      { final: 2, spread: 1, needsHumanReview: false },
    ])).toEqual({ median: 3, spread: 2, needsHumanReview: true });
    // A missing sub leaves the parent without a score (no silent re-weighting over the rest).
    expect(aggregateParent([{ final: 4, spread: 0, needsHumanReview: false }, { final: null, spread: null, needsHumanReview: true }])).toEqual({ median: null, spread: 0, needsHumanReview: true });
    expect(aggregateParent([{ final: 4, spread: 0, needsHumanReview: false }, { final: null, spread: null, needsHumanReview: true, weight: 0 }])).toEqual({ median: 4, spread: 0, needsHumanReview: true });
    expect(aggregateParent([{ final: null, spread: null, needsHumanReview: true }])).toEqual({ median: null, spread: null, needsHumanReview: true });
  });

  it("applies a red-flag cap to the parent", () => {
    expect(aggregateParent([{ final: 5, spread: 0, needsHumanReview: false }, { final: 4, spread: 0, needsHumanReview: false }], 3).median).toBe(3);
    expect(aggregateParent([{ final: 2, spread: 0, needsHumanReview: false }], 3).median).toBe(2);
  });

  it("stage score = Σ weight × criterionTo100(final) ÷ Σ weight, to 0.1, and null while any weighted criterion is ungraded", () => {
    expect(stageScore([{ weight: 25, final: 5 }, { weight: 75, final: 1 }])).toBe(25);
    expect(stageScore([{ weight: 25, final: 3 }, { weight: 20, final: 4 }, { weight: 55, final: 2 }])).toBe(Math.round(((25 * 50 + 20 * 75 + 55 * 25) / 100) * 10) / 10);
    // SWE1 with an unreadable repo and no harness: only S9 (20%) graded → no score, not 100.
    expect(stageScore([{ weight: 30, final: null }, { weight: 25, final: null }, { weight: 10, final: null }, { weight: 15, final: null }, { weight: 20, final: 5 }])).toBeNull();
    expect(stageScore([{ weight: 30, final: 3.5 }, { weight: 70, final: null }])).toBeNull();
    expect(stageScore([{ weight: 30, final: 3.5 }, { weight: 0, final: null }])).toBe(62.5);
    expect(stageScore([{ weight: 30, final: null }])).toBeNull();
  });
});

describe("shared LLM limiter and baseline format", () => {
  it("never runs more than the limit at once across callers", async () => {
    const limit = createLimiter(2);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        limit(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 2 + (i % 3)));
          inFlight--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it("stores the baseline with its prompt version and model, and reads it back", () => {
    const stored = formatBaseline("A generic answer.", { prompt_version: "generic-baseline.v1", model: "m", generated_at: "2026-10-07T10:00:00.000Z" });
    expect(parseBaseline(stored)).toEqual({ answer: "A generic answer.", meta: { prompt_version: "generic-baseline.v1", model: "m", generated_at: "2026-10-07T10:00:00.000Z" } });
    expect(parseBaseline("plain text")).toEqual({ answer: "plain text", meta: {} });
    expect(parseBaseline(null)).toBeNull();
  });
});
