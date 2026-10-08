import { describe, expect, it } from "vitest";
import { FOUR_FIFTHS, MIN_GROUP_SIZE, fourFifths } from "@/lib/stats/four-fifths";

describe("four-fifths rule (docs/09 §9)", () => {
  it("compares each group's rate with the highest group's and flags ratios under 0.8", () => {
    // A: 30/40 = .75 (reference), B: 14/35 = .40 -> .533 flagged, C: 24/40 = .60 -> exactly .80, not flagged
    const r = fourFifths([
      { group: "a", candidates: 40, advanced: 30 },
      { group: "b", candidates: 35, advanced: 14 },
      { group: "c", candidates: 40, advanced: 24 },
    ]);
    expect(r.reference).toEqual({ group: "a", rate: 0.75 });
    const by = Object.fromEntries(r.rows.map((x) => [x.group, x]));
    expect(by.a).toMatchObject({ rate: 0.75, ratio: 1, compared: true, flagged: false });
    expect(by.b.ratio).toBeCloseTo(0.4 / 0.75, 12);
    expect(by.b.flagged).toBe(true);
    expect(by.c.ratio).toBeCloseTo(0.8, 12);
    expect(by.c.flagged).toBe(false); // exactly four-fifths is not adverse impact
    expect(r.flagged).toEqual(["b"]);
    expect(FOUR_FIFTHS).toBe(0.8);
  });

  it("flags just under the line using exact arithmetic", () => {
    // 239/300 = .79667 of 1.0 (30/30)
    const r = fourFifths([
      { group: "x", candidates: 30, advanced: 30 },
      { group: "y", candidates: 300, advanced: 239 },
    ]);
    expect(r.flagged).toEqual(["y"]);
    const r2 = fourFifths([
      { group: "x", candidates: 30, advanced: 30 },
      { group: "y", candidates: 300, advanced: 240 },
    ]);
    expect(r2.flagged).toEqual([]);
  });

  it("leaves 'not disclosed', 'prefer not to say' and suppressed groups out of the comparison", () => {
    const r = fourFifths([
      { group: "not_disclosed", candidates: 200, advanced: 190 }, // highest rate, but not a group
      { group: "prefer_not", candidates: 50, advanced: 5 },
      { group: "female", candidates: 60, advanced: 30 },
      { group: "male", candidates: 70, advanced: 35 },
      { group: "non_binary", candidates: null, advanced: null }, // suppressed (< 30)
    ]);
    expect(r.reference).toEqual({ group: "female", rate: 0.5 });
    expect(r.flagged).toEqual([]);
    const by = Object.fromEntries(r.rows.map((x) => [x.group, x]));
    expect(by.not_disclosed).toMatchObject({ compared: false, ratio: null, flagged: false, rate: 0.95 });
    expect(by.prefer_not).toMatchObject({ compared: false, flagged: false });
    expect(by.non_binary).toMatchObject({ compared: false, rate: null, flagged: false });
  });

  it("never compares groups under the minimum size even if counts are passed", () => {
    const r = fourFifths([
      { group: "a", candidates: MIN_GROUP_SIZE, advanced: 30 },
      { group: "b", candidates: MIN_GROUP_SIZE - 1, advanced: 0 },
    ]);
    expect(r.reference).toBeNull();
    expect(r.flagged).toEqual([]);
  });

  it("needs two comparable groups and a non-zero highest rate", () => {
    expect(fourFifths([{ group: "a", candidates: 40, advanced: 10 }]).reference).toBeNull();
    const zero = fourFifths([
      { group: "a", candidates: 40, advanced: 0 },
      { group: "b", candidates: 40, advanced: 0 },
    ]);
    expect(zero.reference).toBeNull();
    expect(zero.flagged).toEqual([]);
    expect(fourFifths([]).rows).toEqual([]);
  });
});
