import type { Tier } from './types';

/** Hard items answered correctly in under this many ms are flagged for review. */
export const FAST_HARD_MS = 4000;

/** A signal only: never evidence on its own, never grounds for rejection. */
export function isSuspiciouslyFast(x: { tier: Tier; correct: boolean; ms: number }): boolean {
  return x.correct && x.tier === 'hard' && x.ms < FAST_HARD_MS;
}
