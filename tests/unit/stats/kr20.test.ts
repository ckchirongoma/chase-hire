import { describe, expect, it } from "vitest";
import { kr20, kr20Band, kr20FromSummary, kr20Summary } from "@/lib/stats/kr20";

// A perfect Guttman pattern: p = .8/.6/.4/.2 (Σpq = .8), totals 4..0 (σ² = 2),
// KR-20 = 4/3 * (1 - .8/2) = .8.
const GUTTMAN = [
  [1, 1, 1, 1],
  [1, 1, 1, 0],
  [1, 1, 0, 0],
  [1, 0, 0, 0],
  [0, 0, 0, 0],
];

// 8 people x 6 items, worked by hand: Σpq = 1.28125, σ² = 3.25, mean 3.5,
// KR-20 = 6/5 * (1 - 1.28125/3.25) = 0.726923...
const MIXED = [
  [1, 1, 0, 1, 1, 0],
  [1, 0, 0, 1, 0, 0],
  [1, 1, 1, 1, 1, 1],
  [0, 0, 0, 1, 0, 0],
  [1, 1, 1, 0, 1, 0],
  [1, 1, 0, 1, 1, 1],
  [0, 1, 0, 0, 0, 0],
  [1, 1, 1, 1, 0, 1],
];

/** Cronbach's alpha with population variances, computed independently. */
function alpha(m: number[][]): number {
  const k = m[0].length;
  const varPop = (xs: number[]) => {
    const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
    return xs.reduce((a, x) => a + (x - mu) ** 2, 0) / xs.length;
  };
  const itemVars = Array.from({ length: k }, (_, j) => varPop(m.map((r) => r[j])));
  const total = varPop(m.map((r) => r.reduce((a, b) => a + b, 0)));
  return (k / (k - 1)) * (1 - itemVars.reduce((a, b) => a + b, 0) / total);
}

describe("KR-20", () => {
  it("matches the worked Guttman example (.80)", () => {
    expect(kr20Summary(GUTTMAN)).toMatchObject({ n: 5, k: 4, mean: 2 });
    expect(kr20Summary(GUTTMAN).sumPQ).toBeCloseTo(0.8, 12);
    expect(kr20Summary(GUTTMAN).variance).toBeCloseTo(2, 12);
    expect(kr20(GUTTMAN)).toBeCloseTo(0.8, 12);
  });

  it("matches a hand-worked mixed matrix (.7269)", () => {
    const s = kr20Summary(MIXED);
    expect(s).toMatchObject({ n: 8, k: 6, mean: 3.5 });
    expect(s.sumPQ).toBeCloseTo(1.28125, 12);
    expect(s.variance).toBeCloseTo(3.25, 12);
    expect(kr20(MIXED)).toBeCloseTo(0.726923076923077, 12);
  });

  it("equals Cronbach's alpha on 0/1 data", () => {
    expect(kr20(MIXED)).toBeCloseTo(alpha(MIXED), 12);
    expect(kr20(GUTTMAN)).toBeCloseTo(alpha(GUTTMAN), 12);
  });

  it("computes the same value from the SQL sufficient statistics", () => {
    expect(kr20FromSummary({ k: 6, sumPQ: 1.28125, variance: 3.25 })).toBeCloseTo(0.726923076923077, 12);
    // reasoning_kr20_inputs() returns numerics as strings; callers convert with Number().
    expect(kr20FromSummary({ k: 30, sumPQ: Number("1.503906"), variance: Number("10.652344") })).toBeCloseTo(
      (30 / 29) * (1 - 1.503906 / 10.652344),
      12,
    );
  });

  it("is low (here negative) when items disagree with each other", () => {
    // p = .5/.5/.25 (Σpq = .6875), totals 1,1,1,2 (σ² = .1875): 3/2 * (1 - .6875/.1875) = -4
    expect(kr20([[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]])).toBeCloseTo(-4, 12);
  });

  it("is undefined with no score variance, fewer than 2 items or no people", () => {
    expect(kr20([[1, 1], [1, 1]])).toBeNull();
    expect(kr20([[1], [0]])).toBeNull();
    expect(kr20([])).toBeNull();
    expect(kr20FromSummary({ k: 30, sumPQ: 1, variance: 0 })).toBeNull();
    expect(kr20FromSummary({ k: 30, sumPQ: Number.NaN, variance: 2 })).toBeNull();
  });

  it("rejects ragged matrices and non-binary scores", () => {
    expect(() => kr20([[1, 0], [1]])).toThrow(RangeError);
    expect(() => kr20([[1, 2]])).toThrow(RangeError);
  });

  it("bands the coefficient for the report, never below 30 attempts", () => {
    expect(kr20Band(0.9, 10)).toBe("too_few");
    expect(kr20Band(0.65, 30)).toBe("low");
    expect(kr20Band(0.75, 30)).toBe("acceptable");
    expect(kr20Band(0.85, 100)).toBe("good");
    expect(kr20Band(null, 100)).toBeNull();
  });
});
