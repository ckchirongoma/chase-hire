import { describe, expect, it } from "vitest";
import {
  agreementBand,
  criterionStats,
  icc21,
  meanSquares,
  MIN_GOLD,
  quadraticWeightedKappa,
  runPassed,
  statusFor,
  type GoldPair,
} from "@/lib/calibration/stats";

/** Shrout & Fleiss (1979), Table 2: 6 targets rated by 4 judges. */
const SHROUT_FLEISS = [
  [9, 2, 5, 8],
  [6, 1, 3, 2],
  [8, 4, 6, 8],
  [7, 1, 2, 6],
  [10, 5, 6, 9],
  [6, 2, 4, 7],
];

describe("ICC(2,1), absolute agreement", () => {
  it("matches Shrout & Fleiss (1979): BMS 11.24, JMS 32.49, EMS 1.02, ICC(2,1) = .29", () => {
    const ms = meanSquares(SHROUT_FLEISS)!;
    expect(ms.n).toBe(6);
    expect(ms.k).toBe(4);
    expect(ms.msr).toBeCloseTo(11.24, 2);
    expect(ms.msc).toBeCloseTo(32.49, 2);
    expect(ms.mse).toBeCloseTo(1.02, 2);
    expect(icc21(SHROUT_FLEISS)).toBeCloseTo(0.29, 2);
    expect(icc21(SHROUT_FLEISS)).toBeCloseTo(0.2898, 4);
  });

  it("is 1 for perfect agreement", () => {
    expect(icc21([[1, 1], [2, 2], [3, 3], [5, 5]])).toBeCloseTo(1, 12);
    expect(icc21([[1, 1, 1], [4, 4, 4], [2, 2, 2]])).toBeCloseTo(1, 12);
  });

  it("penalises a constant bias (absolute agreement, not consistency)", () => {
    // Raters perfectly consistent but one point apart: MSR 2, MSC 1.5, MSE 0 → 2 / (2 + 2·1.5/3) = 2/3.
    expect(icc21([[1, 2], [2, 3], [3, 4]])).toBeCloseTo(2 / 3, 12);
  });

  it("is negative when raters disagree systematically", () => {
    expect(icc21([[1, 5], [2, 4], [3, 3], [4, 2], [5, 1]])!).toBeLessThan(0);
  });

  it("is null when undefined: fewer than 2 subjects, a single rater, or no variance at all", () => {
    expect(icc21([])).toBeNull();
    expect(icc21([[3, 4]])).toBeNull();
    expect(icc21([[3], [4]])).toBeNull();
    expect(icc21([[3, 3], [3, 3], [3, 3]])).toBeNull();
  });

  it("rejects ragged or non-finite input", () => {
    expect(() => icc21([[1, 2], [3]])).toThrow(RangeError);
    expect(() => icc21([[1, Number.NaN], [3, 4]])).toThrow(RangeError);
  });
});

describe("quadratic weighted kappa", () => {
  it("is 1 for perfect agreement and −1 for perfect reversal", () => {
    expect(quadraticWeightedKappa([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])).toBeCloseTo(1, 12);
    expect(quadraticWeightedKappa([1, 2, 3], [3, 2, 1], 1, 3)).toBeCloseTo(-1, 12);
  });

  it("matches a hand-worked value", () => {
    // O = [[1,1],[0,2]]; E = [[0.5,1.5],[0.5,1.5]]; κ = 1 − (1/4)/(2/4) = .5
    expect(quadraticWeightedKappa([1, 1, 2, 2], [1, 2, 2, 2], 1, 2)).toBeCloseTo(0.5, 12);
    // The same data on the 1–5 scale: quadratic weights are scale-free.
    expect(quadraticWeightedKappa([1, 1, 2, 2], [1, 2, 2, 2])).toBeCloseTo(0.5, 12);
  });

  it("equals 2·cov / (var_a + var_b + (mean_a − mean_b)²), the closed form for quadratic weights", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let trial = 0; trial < 20; trial++) {
      const a = Array.from({ length: 25 }, () => 1 + Math.floor(rnd() * 5));
      const b = a.map((x) => Math.min(5, Math.max(1, x + Math.floor(rnd() * 3) - 1)));
      const m = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
      const ma = m(a);
      const mb = m(b);
      const cov = m(a.map((x, i) => (x - ma) * (b[i] - mb)));
      const va = m(a.map((x) => (x - ma) ** 2));
      const vb = m(b.map((x) => (x - mb) ** 2));
      expect(quadraticWeightedKappa(a, b)).toBeCloseTo((2 * cov) / (va + vb + (ma - mb) ** 2), 10);
    }
  });

  it("rounds to the nearest category (x.5 up) and clamps to the scale", () => {
    expect(quadraticWeightedKappa([1.4, 2.5, 3.6, 7], [1, 3, 4, 5])).toBeCloseTo(1, 12);
  });

  it("is null when undefined: fewer than 2 pairs, or both raters constant", () => {
    expect(quadraticWeightedKappa([3], [3])).toBeNull();
    expect(quadraticWeightedKappa([3, 3, 3], [3, 3, 3])).toBeNull();
    expect(() => quadraticWeightedKappa([1, 2], [1])).toThrow(RangeError);
  });
});

describe("go-live rule (docs/09 §8.3)", () => {
  it("live at ICC ≥ .75, review from .60, human-only below or without enough gold samples", () => {
    expect(statusFor(0.75, MIN_GOLD)).toBe("live");
    expect(statusFor(0.7499, MIN_GOLD)).toBe("review");
    expect(statusFor(0.6, MIN_GOLD)).toBe("review");
    expect(statusFor(0.5999, MIN_GOLD)).toBe("human_only");
    expect(statusFor(null, 30)).toBe("human_only");
    expect(statusFor(0.95, MIN_GOLD - 1)).toBe("human_only");
  });

  it("bands agreement as docs/09 does", () => {
    expect([0.3, 0.5, 0.74, 0.75, 0.89, 0.95, null].map(agreementBand)).toEqual(["poor", "moderate", "moderate", "good", "good", "excellent", "n/a"]);
  });

  it("a run passes only when every criterion is live", () => {
    expect(runPassed({ a: { status: "live" }, b: { status: "live" } })).toBe(true);
    expect(runPassed({ a: { status: "live" }, b: { status: "review" } })).toBe(false);
    expect(runPassed({})).toBe(false);
  });
});

describe("criterionStats", () => {
  const HUMAN = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5];
  const pairs = (ai: (number | null)[], h1 = HUMAN as (number | null)[], h2 = HUMAN as (number | null)[]): GoldPair[] =>
    ai.map((a, i) => ({ goldId: `g${i}`, ai: a, human: [h1[i], h2[i]] }));

  it("perfect agreement: ICC 1, QWK 1, live", () => {
    const s = criterionStats(pairs(HUMAN));
    expect(s).toMatchObject({ icc: 1, qwk: 1, human_icc: 1, n: 10, status: "live", mad: 0 });
    expect(s.pairs).toHaveLength(10);
  });

  it("good agreement goes live; moderate needs review; poor is human-only", () => {
    const good = criterionStats(pairs([2, 2, 3, 4, 4, 1, 3, 3, 5, 4]));
    expect(good.icc).toBe(0.862);
    expect(good.qwk).toBe(0.848);
    expect(good.status).toBe("live");
    const moderate = criterionStats(pairs([3, 1, 2, 5, 4, 2, 3, 2, 4, 5]));
    expect(moderate.icc).toBe(0.724);
    expect(moderate.status).toBe("review");
    const poor = criterionStats(pairs([5, 4, 3, 2, 1, 5, 4, 3, 2, 1]));
    expect(poor.icc!).toBeLessThan(0);
    expect(poor.status).toBe("human_only");
  });

  it("compares the AI with the MEAN of the two humans, and reports human-vs-human ICC", () => {
    const h1 = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5];
    const h2 = [2, 3, 4, 5, 5, 2, 3, 4, 5, 5];
    const ai = h1.map((x, i) => (x + h2[i]) / 2);
    const s = criterionStats(pairs(ai, h1, h2));
    expect(s.icc).toBe(1);
    expect(s.human_icc!).toBeLessThan(1);
    expect(s.mean_human).toBe(3.4);
  });

  it("leaves out samples without an AI score or without both human scores, and says so", () => {
    const ai: (number | null)[] = [...HUMAN];
    ai[0] = null;
    const h2: (number | null)[] = [...HUMAN];
    h2[1] = null;
    const s = criterionStats(pairs(ai, HUMAN, h2));
    expect(s.n).toBe(8);
    expect(s.status).toBe("human_only"); // fewer than MIN_GOLD usable samples
    expect(s.notes.join(" ")).toMatch(/2 gold samples left out/);
    expect(s.notes.join(" ")).toMatch(/at least 10/);
  });

  it("degenerate inputs never throw: no samples, constant scores", () => {
    expect(criterionStats([])).toMatchObject({ n: 0, icc: null, qwk: null, human_icc: null, status: "human_only", mean_ai: null });
    const flat = criterionStats(pairs(Array(10).fill(3), Array(10).fill(3), Array(10).fill(3)));
    expect(flat).toMatchObject({ n: 10, icc: null, qwk: null, status: "human_only" });
    expect(flat.notes.join(" ")).toMatch(/no variance/);
  });
});
