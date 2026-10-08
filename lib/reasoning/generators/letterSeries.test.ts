import { describe, expect, it } from 'vitest';
import { letterSeries } from './letterSeries';
import type { Tier } from '../types';

const SEEDS = Array.from({ length: 500 }, (_, i) => i * 7919 + 1);
const pos = (ch: string) => ch.charCodeAt(0) - 65;
const chr = (i: number) => String.fromCharCode(65 + (((i % 26) + 26) % 26));
const steps = (xs: number[]) => xs.slice(1).map((x, i) => (((x - (xs[i] as number)) % 26) + 26) % 26);
const allEqual = (xs: number[]) => xs.every((x) => x === xs[0]);

/** Next element of a constant-step series of alphabet positions (mod 26). */
function nextConstant(xs: number[]): number {
  const s = steps(xs);
  expect(allEqual(s)).toBe(true);
  return (xs[xs.length - 1] as number) + (s[0] as number);
}

function nextTerm(rule: string, terms: string[]): string {
  switch (rule) {
    case 'constant':
      return chr(nextConstant(terms.map(pos)));
    case 'increasing': {
      const p = terms.map(pos);
      const s = steps(p);
      s.slice(1).forEach((x, i) => expect(x).toBe((s[i] as number) + 1));
      return chr((p[p.length - 1] as number) + (s[s.length - 1] as number) + 1);
    }
    case 'interleaved':
    case 'interleaved_wrap': {
      const p = terms.map(pos);
      const evens = p.filter((_, i) => i % 2 === 0);
      const odds = p.filter((_, i) => i % 2 === 1);
      nextConstant(evens);
      nextConstant(odds);
      return chr(nextConstant(p.length % 2 === 0 ? evens : odds));
    }
    case 'pairs_opposite': {
      const first = terms.map((t) => pos(t[0] as string));
      const second = terms.map((t) => pos(t[1] as string));
      const s1 = steps(first)[0] as number;
      const s2 = steps(second)[0] as number;
      // First letter moves forward, second moves back (as positions mod 26).
      expect(s1).toBeGreaterThanOrEqual(1);
      expect(s1).toBeLessThanOrEqual(12);
      expect(s2).toBeGreaterThanOrEqual(14);
      return chr(nextConstant(first)) + chr(nextConstant(second));
    }
    default:
      throw new Error(`unknown rule ${rule}`);
  }
}

describe('letterSeries', () => {
  it('handles the doc example: AZ, CX, EV -> GT', () => {
    expect(nextTerm('pairs_opposite', ['AZ', 'CX', 'EV'])).toBe('GT');
  });

  for (const tier of ['easy', 'medium', 'hard'] as Tier[]) {
    it(`${tier}: the keyed answer is the independently derived next term`, () => {
      for (const seed of SEEDS) {
        const item = letterSeries(seed, tier);
        const meta = item.meta as { rule: string; terms: string[] };
        expect(item.stem.prompt).toContain(`${meta.terms.join(', ')}, ?`);
        expect(item.options[item.answerIndex]).toBe(nextTerm(meta.rule, meta.terms));
        for (const o of item.options) expect(o).toMatch(/^[A-Z]{1,2}$/);
      }
    });
  }

  it('hard interleaved items always wrap past Z', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const meta = letterSeries(seed, 'hard').meta as { rule: string; terms: string[] };
      if (meta.rule !== 'interleaved_wrap') continue;
      const firstSeries = meta.terms.filter((_, i) => i % 2 === 0).map(pos);
      expect(firstSeries.some((p, i) => i > 0 && p < (firstSeries[i - 1] as number))).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });
});
