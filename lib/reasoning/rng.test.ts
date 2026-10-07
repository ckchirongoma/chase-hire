import { describe, expect, it } from 'vitest';
import { createRng, deriveSeed } from './rng';

describe('rng', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(seqA);
    const c = createRng(43);
    expect(Array.from({ length: 20 }, () => c.next())).not.toEqual(seqA);
    for (const x of seqA) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('int is inclusive and stays in range', () => {
    const r = createRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(3, 6);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
    expect(() => r.int(5, 4)).toThrow();
  });

  it('shuffle returns a permutation without mutating the input; pick picks members', () => {
    const r = createRng(1);
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = r.shuffle(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...out].sort()).toEqual(input);
    for (let i = 0; i < 50; i++) expect(input).toContain(r.pick(input));
    expect(() => r.pick([])).toThrow();
  });

  it('deriveSeed is deterministic and spreads indices', () => {
    expect(deriveSeed(123, 4)).toBe(deriveSeed(123, 4));
    const seeds = new Set(Array.from({ length: 1000 }, (_, i) => deriveSeed(123, i)));
    expect(seeds.size).toBe(1000);
    expect(deriveSeed(123, 1)).not.toBe(deriveSeed(124, 1));
    for (const s of seeds) expect(Number.isInteger(s) && s >= 0 && s < 2 ** 32).toBe(true);
  });
});
