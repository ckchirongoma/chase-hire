import { createRng, deriveSeed } from "@/lib/reasoning/rng";
import { GENERATORS } from "@/lib/reasoning/generators";
import type { AssembledItem } from "@/lib/reasoning/blueprint";
import { MAX_RAW, PROVISIONAL_NORM, percentileFromNormal } from "@/lib/reasoning/scoring";
import type { Family, GeneratedItem, Tier } from "@/lib/reasoning/types";

/**
 * Live reasoning retest (docs/04 §2 and §6): a parallel form of 12 items in 6 minutes, rendered on
 * paper from the form='live' pool with a per-candidate seed. The admin enters the raw score; it
 * becomes a live percentile, and live_delta = online percentile − live percentile. A delta above
 * 25 points is flagged FOR DISCUSSION in the room, never as a rejection, and the retest is not part
 * of any composite (docs/09 §2).
 */

export const LIVE_ITEM_COUNT = 12;
export const LIVE_MINUTES = 6;
/** Online percentile minus live percentile above this is flagged for discussion (docs/04 §6). */
export const LIVE_DELTA_THRESHOLD = 25;

const TIERS: readonly Tier[] = ["easy", "medium", "hard"];

/**
 * Items per family and tier: 12 items, 2 easy / 7 medium / 3 hard, the same mix as the online
 * blueprint (6 / 17 / 7 of 30) and every family represented.
 */
export const LIVE_BLUEPRINT: Record<Family, Record<Tier, number>> = {
  number_series: { easy: 0, medium: 1, hard: 1 },
  data_interp: { easy: 1, medium: 1, hard: 1 },
  deduction: { easy: 0, medium: 2, hard: 0 },
  letter_series: { easy: 1, medium: 1, hard: 0 },
  verbal: { easy: 0, medium: 1, hard: 0 },
  word_problem: { easy: 0, medium: 1, hard: 1 },
};

const FAMILIES = Object.keys(LIVE_BLUEPRINT) as Family[];
const MAX_RESEEDS = 50;

/** A stable key for an item's stem, used to avoid repeating items the candidate saw online. */
export const stemKey = (stem: GeneratedItem["stem"]) => JSON.stringify(stem);

/** Tiers to try for a family when a (family, tier) template has been retired: nearest first. */
const FALLBACK: Record<Tier, Tier[]> = { easy: ["easy", "medium", "hard"], medium: ["medium", "easy", "hard"], hard: ["hard", "medium", "easy"] };

export interface LiveFormOptions {
  /** Active form='live' templates as "family:tier"; omitted = every template is available. */
  available?: ReadonlySet<string>;
  /** Stems the candidate has already seen (their online attempt), as stemKey() strings. */
  exclude?: ReadonlySet<string>;
}

/**
 * Builds the 12-item parallel form for one seed: easy → medium → hard, families shuffled within a
 * tier, every item re-generable from its own seed. A retired template is replaced by the nearest
 * active tier of the same family. Duplicate stems, and stems in `exclude`, are re-seeded.
 */
export function assembleLiveForm(seed: number, opts: LiveFormOptions = {}): AssembledItem[] {
  const rng = createRng(seed);
  const has = (f: Family, t: Tier) => !opts.available || opts.available.has(`${f}:${t}`);
  const slots: Record<Tier, Family[]> = { easy: [], medium: [], hard: [] };
  for (const f of FAMILIES) {
    for (const t of TIERS) {
      for (let n = 0; n < LIVE_BLUEPRINT[f][t]; n++) {
        const tier = FALLBACK[t].find((x) => has(f, x));
        if (!tier) throw new Error(`No active live template for ${f}`);
        slots[tier].push(f);
      }
    }
  }

  const seen = new Set<string>(opts.exclude ?? []);
  const items: AssembledItem[] = [];
  for (const tier of TIERS) {
    for (const family of rng.shuffle(slots[tier])) {
      const position = items.length + 1;
      let itemSeed = deriveSeed(seed, position);
      let item = GENERATORS[family](itemSeed, tier);
      for (let k = 1; seen.has(stemKey(item.stem)) && k <= MAX_RESEEDS; k++) {
        itemSeed = deriveSeed(itemSeed, k);
        item = GENERATORS[family](itemSeed, tier);
      }
      seen.add(stemKey(item.stem));
      items.push({ ...item, seed: itemSeed, position });
    }
  }
  return items;
}

/** A stable 31-bit seed per application (FNV-1a), so a reprint shows the same form. Never 0. */
export function seedForApplication(applicationId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < applicationId.length; i++) {
    h ^= applicationId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 0x7ffffffe) + 1;
}

// ───────────────────────── Norms ─────────────────────────

export interface NormalNorm {
  version: string;
  mean: number;
  sd: number;
}

/**
 * Normal norm for a k-item parallel form, equated to the online applicant-pool norm: the same
 * proportion correct, and the SD scaled through the average inter-item covariance implied by the
 * online norm (var_n = n·p(1−p) + n(n−1)·c̄). Online 13.5 ± 5 on 30 items → 5.4 ± 2.37 on 12.
 *
 * The live norm stays tied to the online applicant pool on purpose: retest takers are a shortlist
 * (range-restricted), so an empirical norm built from them would make every candidate look worse
 * live than online and inflate live_delta.
 */
export function equatedNorm(online: { mean: number; sd: number }, onlineItems: number, items: number, version: string): NormalNorm {
  const p = online.mean / onlineItems;
  const binomial = (n: number) => n * p * (1 - p);
  const cov = (online.sd ** 2 - binomial(onlineItems)) / (onlineItems * (onlineItems - 1));
  const variance = binomial(items) + items * (items - 1) * cov;
  return { version, mean: Math.round(p * items * 1000) / 1000, sd: Math.round(Math.sqrt(Math.max(variance, 0.25)) * 1000) / 1000 };
}

export const LIVE_NORM: NormalNorm = equatedNorm(PROVISIONAL_NORM, MAX_RAW, LIVE_ITEM_COUNT, "live-provisional-normal-v1");

/** Raw 0–12 → live percentile (0–100, 1 dp) under the live norm. */
export function livePercentile(raw: number): { percentile: number; normVersion: string } {
  if (!Number.isInteger(raw) || raw < 0 || raw > LIVE_ITEM_COUNT) {
    throw new RangeError(`livePercentile: raw must be an integer 0..${LIVE_ITEM_COUNT}, got ${raw}`);
  }
  return { percentile: percentileFromNormal(raw, LIVE_NORM.mean, LIVE_NORM.sd), normVersion: LIVE_NORM.version };
}

/** Online percentile minus live percentile (1 dp); null without an online percentile. */
export function liveDelta(onlinePercentile: number | null | undefined, livePct: number): number | null {
  if (onlinePercentile === null || onlinePercentile === undefined || !Number.isFinite(onlinePercentile)) return null;
  return Math.round((onlinePercentile - livePct) * 10) / 10;
}

/** Flag for discussion (never a rejection). */
export const deltaNeedsDiscussion = (delta: number | null | undefined): boolean => typeof delta === "number" && delta > LIVE_DELTA_THRESHOLD;

/** "A".."E" for printed options. */
export const optionLetter = (i: number) => String.fromCharCode(65 + i);
