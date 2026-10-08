import type { Family, GeneratedItem, Tier } from './types';
import { createRng, deriveSeed } from './rng';
import { GENERATORS } from './generators';

export type AssembledItem = GeneratedItem & { seed: number; position: number };

export const TIERS: readonly Tier[] = ['easy', 'medium', 'hard'];

/** Items per family and tier for one attempt: 30 items, 6 easy / 17 medium / 7 hard. */
export const BLUEPRINT: Record<Family, Record<Tier, number>> = {
  number_series: { easy: 1, medium: 3, hard: 1 },
  data_interp: { easy: 1, medium: 4, hard: 2 },
  deduction: { easy: 1, medium: 4, hard: 1 },
  letter_series: { easy: 1, medium: 2, hard: 1 },
  verbal: { easy: 1, medium: 2, hard: 1 },
  word_problem: { easy: 1, medium: 2, hard: 1 },
};

const FAMILIES = Object.keys(BLUEPRINT) as Family[];
const stemKey = (item: GeneratedItem) => JSON.stringify(item.stem);
const MAX_RESEEDS = 50;

/**
 * Build the 30 items for one attempt. Items run easy -> medium -> hard, with families
 * shuffled within each tier. Each item has its own seed, so GENERATORS[family](seed, tier)
 * regenerates it exactly.
 */
export function assembleAttempt(seed: number): AssembledItem[] {
  const rng = createRng(seed);
  const seen = new Set<string>();
  const items: AssembledItem[] = [];

  for (const tier of TIERS) {
    const slots = FAMILIES.flatMap((f) => Array<Family>(BLUEPRINT[f][tier]).fill(f));
    for (const family of rng.shuffle(slots)) {
      const position = items.length + 1;
      let itemSeed = deriveSeed(seed, position);
      let item = GENERATORS[family](itemSeed, tier);
      // Re-seed on the (rare) chance of a duplicate stem within the attempt.
      for (let k = 1; seen.has(stemKey(item)) && k <= MAX_RESEEDS; k++) {
        itemSeed = deriveSeed(itemSeed, k);
        item = GENERATORS[family](itemSeed, tier);
      }
      seen.add(stemKey(item));
      items.push({ ...item, seed: itemSeed, position });
    }
  }
  return items;
}
