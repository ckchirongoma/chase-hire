import { describe, expect, it } from 'vitest';
import { GENERATORS } from './index';
import type { Family, Tier } from '../types';

const FAMILIES = Object.keys(GENERATORS) as Family[];
const TIERS: Tier[] = ['easy', 'medium', 'hard'];
const SEEDS = Array.from({ length: 500 }, (_, i) => i * 7919 + 1);
const BAD_TEXT = /NaN|undefined|Infinity|null|\[object/;

describe('every generator, every tier (500 seeds)', () => {
  it('covers all six families', () => {
    expect(FAMILIES.sort()).toEqual(['data_interp', 'deduction', 'letter_series', 'number_series', 'verbal', 'word_problem']);
  });

  for (const family of FAMILIES) {
    for (const tier of TIERS) {
      it(`${family} / ${tier}: deterministic, 5 distinct options, clean text`, () => {
        const answerSlots = [0, 0, 0, 0, 0];
        for (const seed of SEEDS) {
          const item = GENERATORS[family](seed, tier);
          expect(GENERATORS[family](seed, tier)).toEqual(item);

          expect(item.family).toBe(family);
          expect(item.tier).toBe(tier);
          expect(item.stem.prompt.trim().length).toBeGreaterThan(0);
          expect(item.options).toHaveLength(5);
          expect(new Set(item.options).size).toBe(5);
          for (const o of item.options) expect(o.trim().length).toBeGreaterThan(0);
          expect(Number.isInteger(item.answerIndex)).toBe(true);
          expect(item.answerIndex).toBeGreaterThanOrEqual(0);
          expect(item.answerIndex).toBeLessThan(5);
          expect(JSON.stringify(item.stem) + JSON.stringify(item.options)).not.toMatch(BAD_TEXT);
          answerSlots[item.answerIndex]!++;
        }
        // The correct answer should land in every slot roughly equally often.
        for (const n of answerSlots) expect(n).toBeGreaterThan(SEEDS.length * 0.1);
      });
    }
  }

  it('different seeds give different items', () => {
    for (const family of FAMILIES) {
      for (const tier of TIERS) {
        const stems = new Set(SEEDS.slice(0, 100).map((s) => JSON.stringify(GENERATORS[family](s, tier).stem)));
        expect(stems.size).toBeGreaterThan(70);
      }
    }
  });
});
