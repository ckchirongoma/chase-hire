/**
 * Seeded PRNG for the synthetic assessment data (docs/11). mulberry32 with a murmur3 pre-mix,
 * plus the distribution helpers the generators need. Same seed → same bundle, on every platform.
 */

export interface SynthRng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  /** true with probability p. */
  chance(p: number): boolean;
  pick<T>(arr: readonly T[]): T;
  /** Picks a key by relative weight. */
  weighted<T extends string | number>(entries: readonly (readonly [T, number])[]): T;
  shuffle<T>(arr: readonly T[]): T[];
  /** k distinct items (order random). */
  sample<T>(arr: readonly T[], k: number): T[];
  /** Standard normal (Box-Muller). */
  normal(): number;
  /** A child generator with an independent stream (stable per label). */
  fork(label: string): SynthRng;
  readonly seed: number;
}

function fmix32(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** FNV-1a over a string, for stable fork labels. */
function hashLabel(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createSynthRng(seed: number): SynthRng {
  let state = fmix32(seed >>> 0);

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new RangeError(`rng.int: bad range [${min}, ${max}]`);
    return min + Math.floor(next() * (max - min + 1));
  };

  const pick = <T,>(arr: readonly T[]): T => {
    if (!arr.length) throw new RangeError("rng.pick: empty array");
    return arr[Math.floor(next() * arr.length)] as T;
  };

  const shuffle = <T,>(arr: readonly T[]): T[] => {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  };

  return {
    seed,
    next,
    int,
    chance: (p) => next() < p,
    pick,
    weighted: (entries) => {
      const total = entries.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [k, w] of entries) {
        r -= w;
        if (r < 0) return k;
      }
      return entries[entries.length - 1][0];
    },
    shuffle,
    sample: (arr, k) => shuffle(arr).slice(0, Math.max(0, Math.min(k, arr.length))),
    normal: () => {
      const u = Math.max(next(), 1e-12);
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    fork: (label) => createSynthRng(fmix32((seed >>> 0) ^ hashLabel(label))),
  };
}
