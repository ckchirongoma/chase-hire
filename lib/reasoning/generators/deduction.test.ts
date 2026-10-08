import { describe, expect, it } from 'vitest';
import { clueHolds, deduction, DEDUCTION_RULES, permutations, possibleAt, solveOrders, type Clue } from './deduction';
import type { Tier } from '../types';

const SEEDS = Array.from({ length: 500 }, (_, i) => i * 7919 + 1);
const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth'];

describe('deduction solver', () => {
  it('enumerates all 120 orderings of 5 people', () => {
    const perms = permutations(['A', 'B', 'C', 'D', 'E']);
    expect(perms).toHaveLength(120);
    expect(new Set(perms.map((p) => p.join(''))).size).toBe(120);
  });

  it('evaluates each clue type correctly', () => {
    const order = ['A', 'B', 'C', 'D', 'E'];
    expect(clueHolds({ type: 'before', a: 'A', b: 'E' }, order)).toBe(true);
    expect(clueHolds({ type: 'before', a: 'E', b: 'A' }, order)).toBe(false);
    expect(clueHolds({ type: 'immediately_after', a: 'C', b: 'B' }, order)).toBe(true);
    expect(clueHolds({ type: 'immediately_after', a: 'D', b: 'B' }, order)).toBe(false);
    expect(clueHolds({ type: 'two_after', a: 'D', b: 'B' }, order)).toBe(true);
    expect(clueHolds({ type: 'two_after', a: 'C', b: 'B' }, order)).toBe(false);
    expect(clueHolds({ type: 'not_end', a: 'C' }, order)).toBe(true);
    expect(clueHolds({ type: 'not_end', a: 'E' }, order)).toBe(false);
    expect(clueHolds({ type: 'position', a: 'B', pos: 2 }, order)).toBe(true);
  });

  it('solves a hand-made puzzle', () => {
    const names = ['A', 'B', 'C', 'D', 'E'];
    const clues: Clue[] = [
      { type: 'position', a: 'C', pos: 1 },
      { type: 'immediately_after', a: 'A', b: 'C' },
      { type: 'two_after', a: 'E', b: 'A' },
      { type: 'before', a: 'B', b: 'D' },
    ];
    expect(solveOrders(names, clues)).toEqual([['C', 'A', 'B', 'E', 'D']]);
    expect(possibleAt(names, clues.slice(0, 2), 2)).toEqual(['A']);
    expect(possibleAt(names, clues.slice(0, 2), 3).sort()).toEqual(['B', 'D', 'E']);
  });
});

describe('deduction generator', () => {
  for (const tier of ['easy', 'medium', 'hard'] as Tier[]) {
    it(`${tier}: true clues, unique answer by brute force, within the tier budget`, () => {
      const rules = DEDUCTION_RULES[tier];
      for (const seed of SEEDS) {
        const item = deduction(seed, tier);
        const meta = item.meta as { names: string[]; order: string[]; clues: Clue[]; askedPosition: number };
        expect(new Set(meta.names).size).toBe(5);
        expect([...item.options].sort()).toEqual([...meta.names].sort());
        expect(meta.clues.length).toBeGreaterThanOrEqual(rules.minClues);
        expect(meta.clues.length).toBeLessThanOrEqual(rules.maxClues);
        expect(rules.askable).toContain(meta.askedPosition);
        for (const c of meta.clues) {
          expect(rules.types).toContain(c.type);
          expect(clueHolds(c, meta.order)).toBe(true);
          if (c.type === 'position') expect(c.pos).not.toBe(meta.askedPosition);
          expect(item.stem.prompt).toContain(c.a);
        }
        expect(meta.clues.filter((c) => c.type === 'position').length).toBeLessThanOrEqual(1);

        const solutions = solveOrders(meta.names, meta.clues);
        expect(solutions.length).toBeGreaterThan(0);
        const atAsked = new Set(solutions.map((o) => o[meta.askedPosition - 1]));
        expect(atAsked.size).toBe(1);
        expect(item.options[item.answerIndex]).toBe([...atAsked][0]);
        expect(item.stem.prompt).toMatch(new RegExp(`Who .+ ${ORDINAL[meta.askedPosition - 1]}\\?$`));
        // No single clue gives the answer away on its own, and every clue is needed.
        for (const c of meta.clues) {
          expect(possibleAt(meta.names, [c], meta.askedPosition).length).toBeGreaterThan(1);
          const without = meta.clues.filter((k) => k !== c);
          expect(possibleAt(meta.names, without, meta.askedPosition).length).toBeGreaterThan(1);
        }
      }
    });
  }

  it('hard puzzles never use absolute-position clues and ask a middle position', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const meta = deduction(seed, 'hard').meta as { clues: Clue[]; askedPosition: number };
      expect(meta.clues.every((c) => c.type !== 'position')).toBe(true);
      expect([2, 3, 4]).toContain(meta.askedPosition);
    }
  });
});
