import { describe, expect, it } from 'vitest';
import { formatMagnitude, twoSigFigs, wordProblem } from './wordProblem';
import type { GeneratedItem, Tier } from '../types';

const SEEDS = Array.from({ length: 500 }, (_, i) => i * 7919 + 1);
const randText = (n: number) => `R${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const hoursText = (h: number) => (h === 1 ? '1 hour' : `${h} hours`);

/** "About R2.1 million" -> 2_100_000 */
function parseAmount(s: string): number {
  const m = /R([\d.,]+)( million| billion)?$/.exec(s);
  if (!m) throw new Error(`cannot parse ${s}`);
  const base = Number(m[1]!.replace(/,/g, ''));
  return base * (m[2] === ' billion' ? 1e9 : m[2] === ' million' ? 1e6 : 1);
}

function check(item: GeneratedItem) {
  const meta = item.meta as Record<string, number | string>;
  const p = item.stem.prompt;
  const key = item.options[item.answerIndex]!;
  switch (meta.variant) {
    case 'work_rate': {
      const { a, b, total } = meta as Record<string, number>;
      for (const n of [a, b, total]) expect(p).toContain(` ${n} `);
      const h = total! / (a! + b!);
      expect(Number.isInteger(h)).toBe(true);
      expect(key).toBe(hoursText(h));
      break;
    }
    case 'ratio': {
      const { p: pp, q, diff } = meta as Record<string, number>;
      expect(p).toContain(`ratio ${pp}:${q}`);
      expect(p).toContain(`handled ${diff} more`);
      const total = (diff! / (q! - pp!)) * (pp! + q!);
      expect(key).toBe(`${total.toLocaleString('en-US')} calls`);
      break;
    }
    case 'pct_successive': {
      const { start, up, second } = meta as Record<string, number>;
      expect(p).toContain(randText(start!));
      expect(p).toContain(`${up}%`);
      expect(p).toContain(`${Math.abs(second!)}%`);
      const result = start! * (1 + up! / 100) * (1 + second! / 100);
      expect(Math.abs(result - Math.round(result))).toBeLessThan(1e-6);
      expect(key).toBe(randText(Math.round(result)));
      break;
    }
    case 'inverse_rate': {
      const { a, t } = meta as Record<string, number>;
      expect(p).toContain(`in ${t} hours`);
      expect(p).toContain(`alone would take ${a} hours`);
      const b = 1 / (1 / t! - 1 / a!);
      expect(Math.abs(b - Math.round(b))).toBeLessThan(1e-9);
      expect(key).toBe(hoursText(Math.round(b)));
      break;
    }
    case 'estimate': {
      const { accounts, lines, price } = meta as Record<string, number>;
      expect(p).toContain(accounts!.toLocaleString('en-US'));
      expect(p).toContain(`R${price} a month`);
      const exact = accounts! * lines! * price! * 12;
      const keyed = parseAmount(key);
      expect(keyed / exact).toBeGreaterThan(0.95);
      expect(keyed / exact).toBeLessThan(1.05);
      // Options are a whole order of magnitude apart.
      const values = item.options.map(parseAmount).sort((x, y) => x - y);
      values.slice(1).forEach((v, i) => expect(v / values[i]!).toBeCloseTo(10, 6));
      expect(values[0]).toBeGreaterThanOrEqual(1000);
      expect(values[4]).toBeLessThan(1e12);
      break;
    }
    default:
      throw new Error(`unknown variant ${meta.variant}`);
  }
}

const VARIANTS: Record<Tier, string[]> = {
  easy: ['work_rate'],
  medium: ['ratio', 'pct_successive'],
  hard: ['inverse_rate', 'estimate'],
};

describe('wordProblem', () => {
  for (const tier of ['easy', 'medium', 'hard'] as Tier[]) {
    it(`${tier}: keyed answer recomputed from the parameters in the prompt`, () => {
      for (const seed of SEEDS) {
        const item = wordProblem(seed, tier);
        expect(VARIANTS[tier]).toContain((item.meta as { variant: string }).variant);
        check(item);
      }
    });
  }

  it('formats magnitudes', () => {
    expect(formatMagnitude(19, 6)).toBe('R19 million');
    expect(formatMagnitude(19, 5)).toBe('R1.9 million');
    expect(formatMagnitude(20, 5)).toBe('R2 million');
    expect(formatMagnitude(19, 8)).toBe('R1.9 billion');
    expect(formatMagnitude(19, 4)).toBe('R190,000');
    expect(formatMagnitude(19, 7)).toBe('R190 million');
    expect(formatMagnitude(31, 11)).toBe('R3,100 billion');
    expect(twoSigFigs(19_200_000)).toEqual([19, 6]);
    expect(twoSigFigs(996_000)).toEqual([10, 5]);
  });
});
