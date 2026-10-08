import { createRng } from "@/lib/reasoning/rng";

/**
 * Drift check (docs/09 §8.4): for every 25 real submissions graded against a rubric, a person
 * re-scores 3 picked at random and the agreement is watched. The pick is stable: the same block of
 * submissions always gives the same three, so the list doesn't change between page loads.
 */

export const DRIFT_BLOCK = 25;
export const DRIFT_PICKS = 3;

/** FNV-1a, 32-bit. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface DriftBlock<T> {
  /** 1-based block number. */
  block: number;
  /** Items in the block, in grading order. */
  size: number;
  picks: T[];
}

/**
 * Splits graded items (in a stable order, oldest first) into complete blocks of 25 and picks 3 per
 * block with a seed taken from the rubric and the block's first item. Incomplete trailing blocks
 * get no picks yet.
 */
export function driftPicks<T extends { id: string }>(items: readonly T[], salt: string, block = DRIFT_BLOCK, per = DRIFT_PICKS): DriftBlock<T>[] {
  const out: DriftBlock<T>[] = [];
  for (let start = 0; start + block <= items.length; start += block) {
    const chunk = items.slice(start, start + block);
    const rng = createRng(hash32(`${salt}:${chunk[0].id}`));
    const order = rng.shuffle(chunk.map((_, i) => i)).slice(0, per).sort((a, b) => a - b);
    out.push({ block: start / block + 1, size: chunk.length, picks: order.map((i) => chunk[i]) });
  }
  return out;
}

/** Agreement on re-scored criteria: share within 1 point, and the mean absolute difference. */
export function driftAgreement(pairs: readonly { ai: number; human: number }[]): { n: number; within1: number | null; mad: number | null } {
  if (!pairs.length) return { n: 0, within1: null, mad: null };
  const diffs = pairs.map((p) => Math.abs(p.ai - p.human));
  return {
    n: pairs.length,
    within1: Math.round((diffs.filter((d) => d <= 1).length / diffs.length) * 1000) / 1000,
    mad: Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 1000) / 1000,
  };
}
