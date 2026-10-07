import { describe, expect, it } from 'vitest';
import { dataInterp } from './dataInterp';
import type { GeneratedItem, Tier } from '../types';

const SEEDS = Array.from({ length: 500 }, (_, i) => i * 7919 + 1);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Independent formatters (deliberately not imported from the generator).
const withCommas = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const randText = (n: number) => `R${withCommas(n)}`;
const pctText = (x: number, signed: boolean) => {
  const s = Math.abs(x).toFixed(1);
  if (s === '0.0') return '0.0%';
  return x < 0 ? `-${s}%` : `${signed ? '+' : ''}${s}%`;
};
const parseCell = (c: string | number) => Number(String(c).replace(/^R/, '').replace(/,/g, ''));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const isOneDecimal = (x: number) => Math.abs(x * 10 - Math.round(x * 10)) < 1e-9;

function grid(item: GeneratedItem) {
  const t = item.stem.table!;
  return { regions: t.rows.map((r) => String(r[0])), values: t.rows.map((r) => r.slice(1).map(parseCell)), raw: t.rows };
}

/** Recompute the keyed answer from the rendered table alone. */
function expected(item: GeneratedItem): string {
  const meta = item.meta as Record<string, number | string>;
  const { regions, values } = grid(item);
  const col = (m: number) => values.map((row) => row[m] as number);
  const p = item.stem.prompt;
  const fmt = (n: number) => (meta.unit === 'rand' ? randText(n) : withCommas(n));
  switch (meta.variant) {
    case 'range': {
      const row = values[meta.region as number]!;
      expect(p).toContain(`${regions[meta.region as number]}'s highest month`);
      return fmt(Math.max(...row) - Math.min(...row));
    }
    case 'pct_change': {
      const [i, j] = [meta.fromMonth as number, meta.toMonth as number];
      const x = ((sum(col(j)) - sum(col(i))) / sum(col(i))) * 100;
      expect(isOneDecimal(x)).toBe(true); // designed to be exact to 1 dp
      return pctText(x, true);
    }
    case 'share': {
      const [r, m] = [meta.region as number, meta.month as number];
      expect(p).toContain(`came from ${regions[r]}?`);
      const x = ((values[r]![m] as number) / sum(col(m))) * 100;
      expect(isOneDecimal(x)).toBe(true);
      return pctText(x, false);
    }
    case 'scaled_month_total':
      return randText(sum(col(meta.month as number)) * 1000);
    case 'scaled_region_avg': {
      const r = meta.region as number;
      expect(p).toContain(`${regions[r]}'s average monthly figure`);
      const avg = sum(values[r]!) / 5;
      expect(Number.isInteger(avg)).toBe(true);
      return randText(avg * 1000);
    }
    default:
      throw new Error(`unknown variant ${meta.variant}`);
  }
}

const VARIANTS: Record<Tier, string[]> = {
  easy: ['range'],
  medium: ['pct_change', 'share'],
  hard: ['scaled_month_total', 'scaled_region_avg'],
};

describe('dataInterp', () => {
  for (const tier of ['easy', 'medium', 'hard'] as Tier[]) {
    it(`${tier}: 4 x 5 table, keyed answer recomputed from the table`, () => {
      for (const seed of SEEDS) {
        const item = dataInterp(seed, tier);
        const meta = item.meta as Record<string, unknown>;
        expect(VARIANTS[tier]).toContain(meta.variant);
        const t = item.stem.table!;
        expect(t.columns).toHaveLength(6);
        expect(t.columns[0]).toBe('Region');
        expect(t.rows).toHaveLength(4);
        for (const row of t.rows) expect(row).toHaveLength(6);
        expect(new Set(t.rows.map((r) => r[0])).size).toBe(4);
        // Months are 5 consecutive months
        const idx = MONTHS.findIndex((m) => m.startsWith(t.columns[1] as string));
        expect(t.columns.slice(1)).toEqual(MONTHS.slice(idx, idx + 5).map((m) => m.slice(0, 3)));
        for (const row of grid(item).values) for (const v of row) expect(v).toBeGreaterThan(0);

        expect(item.options[item.answerIndex]).toBe(expected(item));

        if (tier === 'hard') {
          expect(item.stem.footnote).toContain("R'000");
          for (const row of t.rows) for (const c of row.slice(1)) expect(String(c)).not.toMatch(/^R/);
          // The un-scaled figure is always offered as a trap.
          const ans = parseCell(item.options[item.answerIndex]!);
          expect(item.options).toContain(randText(ans / 1000));
        } else {
          expect(item.stem.footnote).toBeUndefined();
        }
      }
    });
  }

  it('medium % distractors include the wrong-base error', () => {
    let hits = 0;
    let n = 0;
    for (const seed of SEEDS) {
      const item = dataInterp(seed, 'medium');
      const meta = item.meta as Record<string, number | string>;
      if (meta.variant !== 'pct_change') continue;
      n++;
      const { values } = grid(item);
      const col = (m: number) => sum(values.map((row) => row[m] as number));
      const [a, b] = [col(meta.fromMonth as number), col(meta.toMonth as number)];
      const wrongBase = Math.round(((b - a) / b) * 1000) / 10;
      if (item.options.includes(pctText(wrongBase, true))) hits++;
    }
    expect(hits / n).toBeGreaterThan(0.9);
  });
});
