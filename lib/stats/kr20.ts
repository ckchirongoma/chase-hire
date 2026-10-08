/**
 * KR-20 (Kuder-Richardson 20): internal-consistency reliability of a test scored right/wrong
 * (docs/04 §1, docs/09 §9, docs/12 §2 "Item statistics and KR-20 are tracked").
 *
 *   KR-20 = k / (k - 1) * (1 - Σ p_j q_j / σ²_X)
 *
 * k items, p_j the proportion correct on item j, q_j = 1 - p_j, σ²_X the variance of the total
 * scores. Population variances throughout (divide by N), so p_j q_j and σ²_X are on the same
 * footing; KR-20 then equals Cronbach's alpha computed on the 0/1 scores.
 *
 * For the reasoning test the "items" are the 30 positions: every attempt has the same tier at
 * each position (lib/reasoning/blueprint.ts), and a skipped or unreached item counts as wrong.
 */

export type Kr20Inputs = {
  /** Number of items. */
  k: number;
  /** Σ p_j (1 - p_j) over the items. */
  sumPQ: number;
  /** Population variance of the total scores. */
  variance: number;
};

/** KR-20 from its sufficient statistics; null when undefined (k < 2 or no score variance). */
export function kr20FromSummary({ k, sumPQ, variance }: Kr20Inputs): number | null {
  if (!Number.isFinite(k) || !Number.isFinite(sumPQ) || !Number.isFinite(variance)) return null;
  if (k < 2 || !(variance > 0)) return null;
  return (k / (k - 1)) * (1 - sumPQ / variance);
}

/** The sufficient statistics of a persons × items matrix of 0/1 scores. */
export function kr20Summary(matrix: readonly (readonly number[])[]): Kr20Inputs & { n: number; mean: number } {
  const n = matrix.length;
  const k = n ? matrix[0].length : 0;
  for (const row of matrix) {
    if (row.length !== k) throw new RangeError("kr20: every person needs a score on every item");
    for (const x of row) if (x !== 0 && x !== 1) throw new RangeError("kr20: scores must be 0 or 1");
  }
  if (!n) return { n: 0, k: 0, sumPQ: 0, variance: 0, mean: 0 };
  let sumPQ = 0;
  for (let j = 0; j < k; j++) {
    let correct = 0;
    for (const row of matrix) correct += row[j];
    const p = correct / n;
    sumPQ += p * (1 - p);
  }
  const totals = matrix.map((row) => row.reduce((a, b) => a + b, 0));
  const mean = totals.reduce((a, b) => a + b, 0) / n;
  const variance = totals.reduce((a, t) => a + (t - mean) ** 2, 0) / n;
  return { n, k, sumPQ, variance, mean };
}

/** KR-20 of a persons × items matrix of 0/1 scores. */
export function kr20(matrix: readonly (readonly number[])[]): number | null {
  return kr20FromSummary(kr20Summary(matrix));
}

/**
 * Reading guide shown next to the coefficient. Docs 04/09 set no threshold; these are the
 * conventional bands for a screening test, not a decision rule.
 */
export function kr20Band(value: number | null, attempts: number): "too_few" | "low" | "acceptable" | "good" | null {
  if (value === null) return null;
  if (attempts < 30) return "too_few";
  if (value < 0.7) return "low";
  if (value < 0.8) return "acceptable";
  return "good";
}
