// Small deterministic PRNG (mulberry32). Same seed => same sequence, on every platform.

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  pick<T>(arr: readonly T[]): T;
  /** Returns a new shuffled array (Fisher-Yates); the input is not modified. */
  shuffle<T>(arr: readonly T[]): T[];
}

/** murmur3 32-bit finaliser: spreads nearby integers across the 32-bit range. */
function fmix32(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function createRng(seed: number): Rng {
  // Pre-mix so consecutive seeds (1, 2, 3...) do not give correlated first draws.
  let state = fmix32(seed >>> 0);

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError(`rng.int: bad range [${min}, ${max}]`);
    }
    return min + Math.floor(next() * (max - min + 1));
  }

  function pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new RangeError('rng.pick: empty array');
    return arr[Math.floor(next() * arr.length)] as T;
  }

  function shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }

  return { next, int, pick, shuffle };
}

/** Derive an independent 32-bit seed for item `index` from a parent seed (murmur3 finaliser). */
export function deriveSeed(seed: number, index: number): number {
  return fmix32((seed >>> 0) ^ Math.imul((index >>> 0) + 1, 0x9e3779b1));
}
