import { describe, expect, it } from 'vitest';
import { assembleAttempt, BLUEPRINT } from './blueprint';
import { GENERATORS } from './generators';
import type { Family, Tier } from './types';

const TIER_RANK: Record<Tier, number> = { easy: 0, medium: 1, hard: 2 };
const ATTEMPT_SEEDS = Array.from({ length: 40 }, (_, i) => i * 104729 + 17);

describe('BLUEPRINT', () => {
  it('totals 30 items: 6 easy / 17 medium / 7 hard', () => {
    const totals: Record<Tier, number> = { easy: 0, medium: 0, hard: 0 };
    for (const f of Object.keys(BLUEPRINT) as Family[]) for (const t of Object.keys(totals) as Tier[]) totals[t] += BLUEPRINT[f][t];
    expect(totals).toEqual({ easy: 6, medium: 17, hard: 7 });
  });

  it('matches the doc 04 family totals (5/7/6/4/4/4)', () => {
    const per = (f: Family) => BLUEPRINT[f].easy + BLUEPRINT[f].medium + BLUEPRINT[f].hard;
    expect([per('number_series'), per('data_interp'), per('deduction'), per('letter_series'), per('verbal'), per('word_problem')]).toEqual([5, 7, 6, 4, 4, 4]);
  });
});

describe('assembleAttempt', () => {
  it('builds 30 items in blueprint proportions, ordered easy -> hard, positions 1..30', () => {
    for (const seed of ATTEMPT_SEEDS) {
      const items = assembleAttempt(seed);
      expect(items).toHaveLength(30);
      expect(items.map((i) => i.position)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
      for (let i = 1; i < items.length; i++) {
        expect(TIER_RANK[items[i]!.tier]).toBeGreaterThanOrEqual(TIER_RANK[items[i - 1]!.tier]);
      }
      expect(items.filter((i) => i.tier === 'easy')).toHaveLength(6);
      expect(items.filter((i) => i.tier === 'medium')).toHaveLength(17);
      expect(items.filter((i) => i.tier === 'hard')).toHaveLength(7);
      for (const f of Object.keys(BLUEPRINT) as Family[]) {
        for (const t of ['easy', 'medium', 'hard'] as Tier[]) {
          expect(items.filter((i) => i.family === f && i.tier === t)).toHaveLength(BLUEPRINT[f][t]);
        }
      }
      expect(new Set(items.map((i) => JSON.stringify(i.stem))).size).toBe(30);
    }
  });

  it('is deterministic per seed and every item regenerates from (family, tier, seed)', () => {
    const seed = 2026;
    const items = assembleAttempt(seed);
    expect(assembleAttempt(seed)).toEqual(items);
    for (const { seed: s, position, ...item } of items) {
      expect(position).toBeGreaterThan(0);
      expect(GENERATORS[item.family](s, item.tier)).toEqual(item);
    }
  });

  it('gives different attempts for different seeds', () => {
    const a = assembleAttempt(1);
    const b = assembleAttempt(2);
    expect(a.map((i) => i.family)).not.toEqual(b.map((i) => i.family));
    const stemsA = new Set(a.map((i) => JSON.stringify(i.stem)));
    expect(b.filter((i) => stemsA.has(JSON.stringify(i.stem))).length).toBeLessThan(3);
  });

  it('shuffles families within a tier across attempts', () => {
    const firstFamilies = new Set(ATTEMPT_SEEDS.map((s) => assembleAttempt(s)[0]!.family));
    expect(firstFamilies.size).toBeGreaterThan(3);
  });
});
