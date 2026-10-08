/**
 * Agreement statistics for grader calibration (docs/09 §8). Pure and dependency-free so the
 * arithmetic is unit-tested against textbook values.
 *
 * - ICC(2,1): two-way random effects, absolute agreement, single rater (Shrout & Fleiss 1979;
 *   McGraw & Wong's ICC(A,1)). Rows are subjects (gold samples), columns are raters.
 * - Quadratic weighted kappa on the 1–5 scale.
 * - Go-live status per criterion: ICC ≥ .75 → live; .60–.75 → live with mandatory human review;
 *   below .60 (or not enough evidence) → human-scored only.
 */

export interface MeanSquares {
  n: number;
  k: number;
  grandMean: number;
  /** Between-subjects (rows) mean square. */
  msr: number;
  /** Between-raters (columns) mean square. */
  msc: number;
  /** Residual mean square. */
  mse: number;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Two-way ANOVA mean squares for an n × k matrix (no missing cells). Null when n < 2 or k < 2. */
export function meanSquares(matrix: readonly (readonly number[])[]): MeanSquares | null {
  const n = matrix.length;
  if (n < 2) return null;
  const k = matrix[0].length;
  if (k < 2) return null;
  if (matrix.some((r) => r.length !== k || !r.every(finite))) throw new RangeError("meanSquares: every row needs the same number of finite scores");
  const grandMean = matrix.flat().reduce((a, b) => a + b, 0) / (n * k);
  const rowMeans = matrix.map((r) => r.reduce((a, b) => a + b, 0) / k);
  const colMeans = Array.from({ length: k }, (_, j) => matrix.reduce((s, r) => s + r[j], 0) / n);
  const ssr = k * rowMeans.reduce((s, m) => s + (m - grandMean) ** 2, 0);
  const ssc = n * colMeans.reduce((s, m) => s + (m - grandMean) ** 2, 0);
  const sst = matrix.flat().reduce((s, x) => s + (x - grandMean) ** 2, 0);
  const sse = Math.max(0, sst - ssr - ssc);
  return { n, k, grandMean, msr: ssr / (n - 1), msc: ssc / (k - 1), mse: sse / ((n - 1) * (k - 1)) };
}

const EPS = 1e-12;

/** ICC(2,1), absolute agreement. Null when it is undefined (fewer than 2 subjects, or no variance at all). */
export function icc21(matrix: readonly (readonly number[])[]): number | null {
  const ms = meanSquares(matrix);
  if (!ms) return null;
  const { n, k, msr, msc, mse } = ms;
  const denom = msr + (k - 1) * mse + (k * (msc - mse)) / n;
  if (Math.abs(denom) < EPS) return null;
  return (msr - mse) / denom;
}

/**
 * Quadratic weighted kappa between two raters on an integer scale [min, max] (default 1–5).
 * Scores are rounded to the nearest category first (x.5 rounds up) and clamped to the scale.
 * Null when undefined: fewer than 2 pairs, or no expected disagreement (both raters constant).
 */
export function quadraticWeightedKappa(a: readonly number[], b: readonly number[], min = 1, max = 5): number | null {
  if (a.length !== b.length) throw new RangeError("quadraticWeightedKappa: rater arrays differ in length");
  if (!a.every(finite) || !b.every(finite)) throw new RangeError("quadraticWeightedKappa: scores must be finite numbers");
  const n = a.length;
  if (n < 2) return null;
  const K = max - min + 1;
  const cat = (x: number) => Math.min(max, Math.max(min, Math.round(x))) - min;
  const observed = Array.from({ length: K }, () => new Array<number>(K).fill(0));
  const rowM = new Array<number>(K).fill(0);
  const colM = new Array<number>(K).fill(0);
  for (let i = 0; i < n; i++) {
    const x = cat(a[i]);
    const y = cat(b[i]);
    observed[x][y]++;
    rowM[x]++;
    colM[y]++;
  }
  let num = 0;
  let den = 0;
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      const w = (i - j) ** 2 / (K - 1) ** 2;
      num += w * observed[i][j];
      den += (w * rowM[i] * colM[j]) / n;
    }
  }
  if (den < EPS) return null;
  return 1 - num / den;
}

// ───────────────────────── Go-live rule ─────────────────────────

export const ICC_LIVE = 0.75;
export const ICC_REVIEW = 0.6;
/** Below this many gold samples with an AI score and both human scores, a criterion stays human-only. */
export const MIN_GOLD = 10;
/** docs/09 §8: 20–30 gold samples per work rubric. */
export const RECOMMENDED_GOLD = 20;

export type CalibrationStatus = "live" | "review" | "human_only";

export const STATUS_LABEL: Record<CalibrationStatus, string> = {
  live: "Live",
  review: "Live with mandatory human review",
  human_only: "Human-scored only",
};

export function statusFor(icc: number | null, n: number): CalibrationStatus {
  if (icc === null || n < MIN_GOLD) return "human_only";
  if (icc >= ICC_LIVE) return "live";
  if (icc >= ICC_REVIEW) return "review";
  return "human_only";
}

/** docs/09 §8: < .50 poor, .50–.75 moderate, .75–.90 good (above .90 excellent). */
export function agreementBand(v: number | null): "poor" | "moderate" | "good" | "excellent" | "n/a" {
  if (v === null) return "n/a";
  if (v < 0.5) return "poor";
  if (v < 0.75) return "moderate";
  if (v < 0.9) return "good";
  return "excellent";
}

// ───────────────────────── Per criterion ─────────────────────────

export interface GoldPair {
  goldId: string;
  /** The AI final score (median of 3 samples, or the computed score) on 1–5. */
  ai: number | null;
  /** The two human raters' scores on 1–5. */
  human: readonly [number | null, number | null];
}

export interface CriterionStats {
  icc: number | null;
  qwk: number | null;
  /** Gold samples with an AI score and both human scores. */
  n: number;
  /** Human-vs-human ICC(2,1), for reference. */
  human_icc: number | null;
  status: CalibrationStatus;
  mean_ai: number | null;
  mean_human: number | null;
  /** Mean |AI − mean human|. */
  mad: number | null;
  notes: string[];
  pairs: { gold_id: string; ai: number; human: [number, number] }[];
}

const round3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
const isScore = (v: unknown): v is number => finite(v) && v >= 1 && v <= 5;
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** ICC(2,1) and QWK between the AI final score and the mean of the two humans, plus human-vs-human ICC. */
export function criterionStats(pairs: readonly GoldPair[]): CriterionStats {
  const used = pairs
    .filter((p) => isScore(p.ai) && isScore(p.human[0]) && isScore(p.human[1]))
    .map((p) => ({ gold_id: p.goldId, ai: p.ai as number, human: [p.human[0], p.human[1]] as [number, number] }));
  const n = used.length;
  const humanMean = used.map((p) => (p.human[0] + p.human[1]) / 2);
  const icc = round3(icc21(used.map((p, i) => [p.ai, humanMean[i]])));
  const qwk = round3(n >= 2 ? quadraticWeightedKappa(used.map((p) => p.ai), humanMean) : null);
  const humanIcc = round3(icc21(used.map((p) => [p.human[0], p.human[1]])));
  const notes: string[] = [];
  const skipped = pairs.length - n;
  if (skipped > 0) notes.push(`${skipped} gold sample${skipped === 1 ? "" : "s"} left out (no AI score or not scored by both humans)`);
  if (n < MIN_GOLD) notes.push(`only ${n} usable gold sample${n === 1 ? "" : "s"}: at least ${MIN_GOLD} are needed before this criterion can go live`);
  else if (n < RECOMMENDED_GOLD) notes.push(`${n} gold samples: docs/09 asks for 20–30`);
  if (n >= 2 && icc === null) notes.push("no variance in the scores: the gold set must span weak to excellent");
  if (humanIcc !== null && humanIcc < ICC_REVIEW) notes.push(`the two humans agree poorly (ICC ${humanIcc}): fix the anchors before trusting the AI comparison`);
  return {
    icc,
    qwk,
    n,
    human_icc: humanIcc,
    status: statusFor(icc, n),
    mean_ai: round3(mean(used.map((p) => p.ai))),
    mean_human: round3(mean(humanMean)),
    mad: round3(mean(used.map((p, i) => Math.abs(p.ai - humanMean[i])))),
    notes,
    pairs: used,
  };
}

/** A rubric passes calibration when every calibrated criterion is live. */
export function runPassed(perCriterion: Readonly<Record<string, { status: CalibrationStatus }>>): boolean {
  const all = Object.values(perCriterion);
  return all.length > 0 && all.every((c) => c.status === "live");
}
