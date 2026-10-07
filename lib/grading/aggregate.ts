/**
 * Pure aggregation for LLM-judge samples (docs/09 §7.5): 3 samples, take the median,
 * a spread of 2 or more points on a criterion needs a human.
 */

export const REVIEW_SPREAD = 2;

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface Aggregate {
  median: number | null;
  /** max − min; null when there are no scores. */
  spread: number | null;
  needsHumanReview: boolean;
}

export function aggregate(scores: readonly number[]): Aggregate {
  if (!scores.length) return { median: null, spread: null, needsHumanReview: true };
  const spread = Math.max(...scores) - Math.min(...scores);
  return { median: median(scores), spread, needsHumanReview: spread >= REVIEW_SPREAD };
}

/** Maps a 1–5 criterion score onto 0–100 (1 → 0, 3 → 50, 5 → 100). */
export function criterionTo100(score: number): number {
  const clamped = Math.min(5, Math.max(1, score));
  return ((clamped - 1) / 4) * 100;
}

/**
 * Weighted mean of the non-null values. Falls back to a plain mean when every weight is 0,
 * and returns null when there is nothing to average.
 */
export function weightedMean(items: readonly { value: number | null; weight: number }[]): number | null {
  const present = items.filter((i): i is { value: number; weight: number } => i.value !== null && Number.isFinite(i.value));
  if (!present.length) return null;
  const totalWeight = present.reduce((s, i) => s + Math.max(0, i.weight), 0);
  if (totalWeight <= 0) return present.reduce((s, i) => s + i.value, 0) / present.length;
  return present.reduce((s, i) => s + i.value * Math.max(0, i.weight), 0) / totalWeight;
}

/** Index of the value closest to `target` (ties → the earliest). */
export function closestIndex(values: readonly number[], target: number): number {
  let best = -1;
  let bestDist = Infinity;
  values.forEach((v, i) => {
    const d = Math.abs(v - target);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}
