// Scoring for the Reasoning Assessment: raw score -> percentile -> stars.
// Scores are advisory: nothing here rejects a candidate.

export type Stars = 1 | 2 | 3 | 4 | 5 | 6;

export const MAX_RAW = 30;

/** Used until 100+ attempts exist; label it "provisional" in the UI. */
export const PROVISIONAL_NORM = { version: 'provisional-normal-v1', mean: 13.5, sd: 5 } as const;

/** Skipped (null) items count as wrong. */
export function rawScore(responses: { correct: boolean | null }[]): number {
  return responses.filter((r) => r.correct === true).length;
}

/** Error function, Abramowitz & Stegun 7.1.26 (max abs error ~1.5e-7). */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/** Standard normal CDF. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Percentile (0..100, 1 dp) of `raw` under a normal norm. */
export function percentileFromNormal(raw: number, mean: number, sd: number): number {
  if (!(sd > 0)) throw new RangeError('percentileFromNormal: sd must be > 0');
  return clamp(round1(100 * normalCdf((raw - mean) / sd)), 0, 100);
}

/** Mid-rank percentile of `raw` within observed scores: 100 * (below + 0.5 * equal) / n, 1 dp. */
export function percentileFromEmpirical(raw: number, scores: number[]): number {
  if (scores.length === 0) throw new RangeError('percentileFromEmpirical: no scores');
  const below = scores.filter((s) => s < raw).length;
  const equal = scores.filter((s) => s === raw).length;
  return clamp(round1((100 * (below + 0.5 * equal)) / scores.length), 0, 100);
}

/** <20 -> 1, 20-<40 -> 2, 40-<60 -> 3, 60-<80 -> 4, 80-<95 -> 5, >=95 -> 6. */
export function starsFromPercentile(p: number): Stars {
  if (p >= 95) return 6;
  if (p >= 80) return 5;
  if (p >= 60) return 4;
  if (p >= 40) return 3;
  if (p >= 20) return 2;
  return 1;
}

export function scoreAttempt(raw: number): { raw: number; percentile: number; stars: number; normVersion: string } {
  if (!Number.isInteger(raw) || raw < 0 || raw > MAX_RAW) {
    throw new RangeError(`scoreAttempt: raw must be an integer 0..${MAX_RAW}, got ${raw}`);
  }
  const percentile = percentileFromNormal(raw, PROVISIONAL_NORM.mean, PROVISIONAL_NORM.sd);
  return { raw, percentile, stars: starsFromPercentile(percentile), normVersion: PROVISIONAL_NORM.version };
}
