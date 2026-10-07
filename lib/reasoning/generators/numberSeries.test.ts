import { describe, expect, it } from 'vitest';
import { numberSeries } from './numberSeries';
import type { Tier } from '../types';

const SEEDS = Array.from({ length: 500 }, (_, i) => i * 7919 + 1);
const diffs = (xs: number[]) => xs.slice(1).map((x, i) => x - (xs[i] as number));
const allEqual = (xs: number[]) => xs.every((x) => x === xs[0]);
const lastOf = (xs: number[]) => xs[xs.length - 1] as number;

/** Re-derive the next term from the shown terms alone, checking the rule really holds. */
function nextTerm(rule: string, t: number[], params: Record<string, unknown>): number {
  const d = diffs(t);
  switch (rule) {
    case 'arithmetic':
      expect(allEqual(d)).toBe(true);
      return lastOf(t) + (d[0] as number);
    case 'geometric': {
      // Constant ratio t1/t0 (checked by cross-multiplying, so dividing series stay exact).
      const [t0, t1] = [t[0] as number, t[1] as number];
      t.slice(1).forEach((x, i) => expect(x * t0).toBe((t[i] as number) * t1));
      const next = (lastOf(t) * t1) / t0;
      expect(Number.isInteger(next)).toBe(true);
      return next;
    }
    case 'second_order': {
      const dd = diffs(d);
      expect(allEqual(dd)).toBe(true);
      return lastOf(t) + lastOf(d) + (dd[0] as number);
    }
    case 'interleaved': {
      const evens = t.filter((_, i) => i % 2 === 0);
      const odds = t.filter((_, i) => i % 2 === 1);
      expect(allEqual(diffs(evens))).toBe(true);
      expect(allEqual(diffs(odds))).toBe(true);
      const series = t.length % 2 === 0 ? evens : odds;
      return lastOf(series) + (diffs(series)[0] as number);
    }
    case 'alternating_ops': {
      // Infer +a and *b from the first two steps, check the rest, then apply the next op.
      const addFirst = params.firstOp === 'add';
      const add = addFirst ? (t[1] as number) - (t[0] as number) : (t[2] as number) - (t[1] as number);
      const mul = addFirst ? (t[2] as number) / (t[1] as number) : (t[1] as number) / (t[0] as number);
      const step = (x: number, i: number) => ((i % 2 === 0) === addFirst ? x + add : x * mul);
      t.slice(1).forEach((x, i) => expect(x).toBe(step(t[i] as number, i)));
      return step(lastOf(t), t.length - 1);
    }
    case 'diff_squares':
    case 'diff_cubes': {
      const power = rule === 'diff_squares' ? 2 : 3;
      const k0 = Math.round((d[0] as number) ** (1 / power));
      d.forEach((x, i) => expect(x).toBe((k0 + i) ** power));
      return lastOf(t) + (k0 + d.length) ** power;
    }
    case 'diff_geometric': {
      const r = (d[1] as number) / (d[0] as number);
      d.slice(1).forEach((x, i) => expect(x).toBe((d[i] as number) * r));
      return lastOf(t) + lastOf(d) * r;
    }
    case 'fibonacci_plus': {
      const ks = t.slice(2).map((x, i) => x - (t[i] as number) - (t[i + 1] as number));
      expect(allEqual(ks)).toBe(true);
      return lastOf(t) + (t[t.length - 2] as number) + (ks[0] as number);
    }
    default:
      throw new Error(`unknown rule ${rule}`);
  }
}

const RULES: Record<Tier, string[]> = {
  easy: ['arithmetic', 'geometric'],
  medium: ['second_order', 'interleaved', 'alternating_ops'],
  hard: ['diff_squares', 'diff_cubes', 'diff_geometric', 'fibonacci_plus'],
};

describe('numberSeries', () => {
  it('reproduces the doc example rule: 3, 4, 8, 17, 33 -> 58', () => {
    expect(nextTerm('diff_squares', [3, 4, 8, 17, 33], {})).toBe(58);
  });

  for (const tier of ['easy', 'medium', 'hard'] as Tier[]) {
    it(`${tier}: the keyed answer is the independently derived next term`, () => {
      const seen = new Set<string>();
      for (const seed of SEEDS) {
        const item = numberSeries(seed, tier);
        const meta = item.meta as { rule: string; terms: number[]; params: Record<string, unknown> };
        seen.add(meta.rule);
        expect(RULES[tier]).toContain(meta.rule);
        expect(meta.terms.length).toBeGreaterThanOrEqual(5);
        expect(meta.terms.length).toBeLessThanOrEqual(7);
        expect(item.stem.prompt).toContain(`${meta.terms.join(', ')}, ?`);
        expect(item.options[item.answerIndex]).toBe(String(nextTerm(meta.rule, meta.terms, meta.params)));
        for (const o of item.options) expect(o).toMatch(/^-?\d+$/);
      }
      expect([...seen].sort()).toEqual([...RULES[tier]].sort());
    });
  }
});
