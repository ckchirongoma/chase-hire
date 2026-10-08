import { median, weightedMean, criterionTo100 } from "./aggregate";
import { quoteAppears } from "./quotes";
import type { MappingItem } from "./schema";

/**
 * Pure scoring for reference-guided and computed work-sample criteria (docs/06, 07, 08, 09).
 * Every function here is deterministic so the arithmetic is unit-tested apart from any model.
 */

export type MappingStatus = MappingItem["status"];
export const CREDIT: Record<MappingStatus, number> = { found: 1, partial: 0.5, missing: 0 };

export interface WeightedItem {
  id: string;
  weight: number;
}

export interface ConsolidatedItem {
  id: string;
  /** Median credit across the valid samples (1, 0.5 or 0 with 3 samples). */
  credit: number;
  status: MappingStatus;
  /** Status in each sample, in sample order ("missing" when a sample left the item out). */
  perSample: MappingStatus[];
  /** A quote from a sample that agreed with the median status, if any. */
  quote: string;
}

const statusOf = (credit: number): MappingStatus => (credit >= 1 ? "found" : credit > 0 ? "partial" : "missing");

/**
 * Per-item median across samples (docs/09 §7.5 applied per answer-key item). Items a sample did
 * not mention count as missing in that sample; ids outside `ids` are ignored.
 */
export function consolidateMapping(samples: readonly (readonly MappingItem[])[], ids: readonly string[]): ConsolidatedItem[] {
  return ids.map((id) => {
    const perSample = samples.map((s) => s.find((m) => m.id === id)?.status ?? "missing");
    const credit = samples.length ? (median(perSample.map((p) => CREDIT[p])) ?? 0) : 0;
    const status = statusOf(credit);
    const quote = samples.map((s) => s.find((m) => m.id === id)).find((m) => m && m.status === status && m.quote)?.quote ?? "";
    return { id, credit, status, perSample, quote };
  });
}

// ───────────────────────── Quote checks on reference mappings ─────────────────────────

/** A mapping item after its quote was checked against the submission. */
export type VerifiedMappingItem = MappingItem & {
  /** The status the judge claimed when it was downgraded for lack of a verifiable quote. */
  claimed?: MappingStatus;
  unverified?: true;
};

/**
 * Hard rule 4 for answer-key items: a found or partial item must carry a quote that actually
 * appears in the submission. Items with an empty or unfindable quote get no credit (status
 * "missing", with the judge's claim kept in `claimed`) and are listed for a person to check.
 */
export function verifyMappingQuotes(mapping: readonly MappingItem[], subject: string): { mapping: VerifiedMappingItem[]; unverified: string[] } {
  const unverified: string[] = [];
  const out = mapping.map((m): VerifiedMappingItem => {
    if (m.status === "missing") return m;
    if (m.quote.trim() && quoteAppears(m.quote, subject)) return m;
    unverified.push(m.id);
    return { ...m, status: "missing", claimed: m.status, unverified: true };
  });
  return { mapping: out, unverified };
}

/** Red flags lower scores, so each needs a quote from the submission; unsupported flags are dropped and listed. */
export function verifyRedFlagQuotes<T extends { id: string; quote: string }>(flags: readonly T[], subject: string): { flags: T[]; unverified: string[] } {
  const kept: T[] = [];
  const unverified: string[] = [];
  for (const f of flags) {
    if (f.quote.trim() && quoteAppears(f.quote, subject)) kept.push(f);
    else unverified.push(f.id);
  }
  return { flags: kept, unverified };
}

/** Extra gaps are for a person only; mark the ones whose quote is not in the submission. */
export function markUnverifiedGaps<T extends { quote: string }>(gaps: readonly T[], subject: string): (T & { unverified?: true })[] {
  return gaps.map((g) => (g.quote.trim() && quoteAppears(g.quote, subject) ? g : { ...g, unverified: true as const }));
}

/** Σ weight × credit over the key. */
export function weightedPoints(credits: ReadonlyMap<string, number> | Record<string, number>, items: readonly WeightedItem[]): number {
  const get = (id: string) => (credits instanceof Map ? credits.get(id) : (credits as Record<string, number>)[id]) ?? 0;
  return items.reduce((s, i) => s + i.weight * get(i.id), 0);
}

export const totalWeight = (items: readonly WeightedItem[]) => items.reduce((s, i) => s + i.weight, 0);

/** 1–5 from a 0–1 share: 1 + 4 × share (rounded to 2 dp, clamped). */
export function shareToScore(share: number): number {
  const s = Math.min(1, Math.max(0, Number.isFinite(share) ? share : 0));
  return Math.round((1 + 4 * s) * 100) / 100;
}

const round = (n: number, dp = 4) => Math.round(n * 10 ** dp) / 10 ** dp;

// ───────────────────────── BA Part 1 ─────────────────────────

export interface RecallResult {
  points: number;
  max: number;
  recall: number;
  score: number;
}

/** Gap recall (docs/06): Σ(weight × {found 1, partial 0.5}) ÷ total (40 for the D-code key). */
export function gapRecall(credits: ReadonlyMap<string, number> | Record<string, number>, items: readonly WeightedItem[], max = totalWeight(items)): RecallResult {
  const points = weightedPoints(credits, items);
  const recall = max > 0 ? points / max : 0;
  return { points: round(points, 2), max, recall: round(recall), score: shareToScore(recall) };
}

export interface YieldResult {
  revealed: string[];
  points: number;
  max: number;
  share: number;
  score: number;
}

/** Elicitation yield (docs/06): weights of the distinct hidden facts revealed ÷ 30. */
export function elicitationYield(revealedIds: readonly string[], facts: readonly WeightedItem[], max = totalWeight(facts)): YieldResult {
  const known = new Map(facts.map((f) => [f.id.toUpperCase(), f.weight]));
  const revealed = [...new Set(revealedIds.map((r) => r.toUpperCase()))].filter((r) => known.has(r)).sort();
  const points = revealed.reduce((s, r) => s + (known.get(r) ?? 0), 0);
  const share = max > 0 ? points / max : 0;
  return { revealed, points, max, share: round(share), score: shareToScore(share) };
}

// ───────────────────────── SWE Test 2 ─────────────────────────

/**
 * Red-flag caps (docs/08). An item cap limits that answer-key item's credit; a criterion cap
 * limits a whole criterion's 1–5 score (e.g. exec comms ≤ 3 when automatic takedowns are accepted).
 */
export interface RedFlagRule {
  id: string;
  description: string;
  item_caps?: Record<string, number>;
  criterion_caps?: Record<string, number>;
}

export interface CoverageResult {
  points: number;
  max: number;
  coverage: number;
  score: number;
  /** Item credits after caps. */
  credits: Record<string, number>;
  /** Items whose credit a red flag lowered: {A02: {from: 1, to: 0, flag: "crawler"}}. */
  capped: Record<string, { from: number; to: number; flag: string }>;
  /** Caps on other criteria, keyed by criterion key (lowest cap wins). */
  criterionCaps: Record<string, number>;
  flags: string[];
}

export function answerKeyCoverage(
  credits: Record<string, number>,
  items: readonly WeightedItem[],
  redFlags: readonly string[],
  rules: readonly RedFlagRule[],
  max = totalWeight(items),
): CoverageResult {
  const after: Record<string, number> = Object.fromEntries(items.map((i) => [i.id, credits[i.id] ?? 0]));
  const capped: CoverageResult["capped"] = {};
  const criterionCaps: Record<string, number> = {};
  const flags = [...new Set(redFlags)].filter((f) => rules.some((r) => r.id === f)).sort();
  for (const flag of flags) {
    const rule = rules.find((r) => r.id === flag)!;
    for (const [item, cap] of Object.entries(rule.item_caps ?? {})) {
      if (item in after && after[item] > cap) {
        capped[item] = { from: capped[item]?.from ?? after[item], to: cap, flag };
        after[item] = cap;
      }
    }
    for (const [crit, cap] of Object.entries(rule.criterion_caps ?? {})) {
      criterionCaps[crit] = Math.min(criterionCaps[crit] ?? Infinity, cap);
    }
  }
  const points = weightedPoints(after, items);
  const coverage = max > 0 ? points / max : 0;
  return { points: round(points, 2), max, coverage: round(coverage), score: shareToScore(coverage), credits: after, capped, criterionCaps, flags };
}

/** A red flag counts when at least `minVotes` of the samples report it (majority of 3). */
export function majorityFlags(samples: readonly (readonly string[])[], minVotes = 2): string[] {
  const votes = new Map<string, number>();
  for (const s of samples) for (const f of new Set(s)) votes.set(f, (votes.get(f) ?? 0) + 1);
  return [...votes.entries()].filter(([, n]) => n >= minVotes).map(([f]) => f).sort();
}

// ───────────────────────── SWE Test 1 ─────────────────────────

/**
 * Fault-discovery points (max 21) → the doc 09 §6 S1 anchors: < 6 → 1, 10–14 → 3, ≥ 18 → 5,
 * linear in between (6 → 1 rising to 10 → 3; 14 → 3 rising to 18 → 5).
 */
export function faultPointsToScore(points: number): number {
  const p = Math.max(0, points);
  let s: number;
  if (p < 6) s = 1;
  else if (p < 10) s = 1 + ((p - 6) / 4) * 2;
  else if (p <= 14) s = 3;
  else if (p < 18) s = 3 + ((p - 14) / 4) * 2;
  else s = 5;
  return Math.round(s * 100) / 100;
}

/** Harness results by check key (latest run): true pass, false fail, absent = not run. */
export type HarnessResults = Record<string, boolean | null | undefined>;

export interface HarnessScore {
  score: number | null;
  /** Checks this criterion needs that have no result. */
  missing: string[];
  basis: string;
  /** Set when the harness alone cannot reach the 5-anchor: the score is capped at 4 until a person confirms this. */
  confirm?: string;
}

/** The highest score the harness can give on its own when the 5-anchor needs things no check covers. */
export const HARNESS_ONLY_MAX = 4;

function capForConfirmation(h: HarnessScore, confirm: string): HarnessScore {
  if (h.score === null || h.score <= HARNESS_ONLY_MAX) return h;
  return { ...h, score: HARNESS_ONLY_MAX, basis: `${h.basis}; capped at ${HARNESS_ONLY_MAX} until a person confirms the rest of the 5-anchor`, confirm };
}

const passed = (r: HarnessResults, k: string) => r[k] === true;
const ran = (r: HarnessResults, k: string) => r[k] === true || r[k] === false;

function harness(r: HarnessResults, keys: readonly string[], required: readonly string[], fn: () => { score: number; basis: string }): HarnessScore {
  const notRun = keys.filter((k) => !ran(r, k));
  const requiredMissing = required.filter((k) => !ran(r, k));
  // Without the deciding checks the harness cannot score this criterion (not run ≠ failed).
  if (requiredMissing.length) return { score: null, missing: notRun, basis: `harness not run (${requiredMissing.join(", ")} missing)` };
  const { score, basis } = fn();
  return { score, missing: notRun, basis };
}

/**
 * S2 import (M1–M7): fails M1 or M6 → 1; M1–M3 + M6 → 3; + some of M4/M5/M7 → 4; all seven → 5.
 * Needs M1 and M6 to have run; other checks that did not run count as not passed (and are listed).
 */
export function importScoreFromHarness(r: HarnessResults): HarnessScore {
  const keys = ["M1", "M2", "M3", "M4", "M5", "M6", "M7"];
  return harness(r, keys, ["M1", "M6"], () => {
    if (!passed(r, "M1") || !passed(r, "M6")) return { score: 1, basis: "fails M1 or M6" };
    if (keys.every((k) => passed(r, k))) return { score: 5, basis: "passes M1–M7" };
    if (!["M2", "M3"].every((k) => passed(r, k))) return { score: 2, basis: "passes M1 and M6 but not M2–M3" };
    const extra = ["M4", "M5", "M7"].filter((k) => passed(r, k)).length;
    return extra ? { score: 4, basis: `passes M1–M3, M6 and ${extra} of M4/M5/M7` } : { score: 3, basis: "passes M1–M3 and M6" };
  });
}

/**
 * S3 stories (U6 = RD-07, U7 = RD-11, R5 = tests): none → 1; one → 3; both → 4; both + tests → 5
 * in principle, but R5 only proves tests for the import and RD-07, so the harness alone stops at 4
 * until a person confirms an RD-11 test.
 */
export function storiesScoreFromHarness(r: HarnessResults): HarnessScore {
  const h = harness(r, ["U6", "U7", "R5"], ["U6", "U7"], () => {
    const n = ["U6", "U7"].filter((k) => passed(r, k)).length;
    if (n === 0) return { score: 1, basis: "neither RD-07 nor RD-11 enforced server-side" };
    if (n === 1) return { score: 3, basis: "one story enforced" };
    return passed(r, "R5") ? { score: 5, basis: "both enforced, with tests" } : { score: 4, basis: "both enforced, tests missing or failing" };
  });
  return capForConfirmation(h, "R5 does not cover RD-11: confirm a test for the opt-out rule to award 5");
}

/**
 * S4 deploy & ops: U1 health fails → 1; otherwise 2 + 0.75 per passing R4 (build), R5 (tests),
 * R6 (CI), R7 (env hygiene). The 5-anchor also needs error monitoring, a rollback note and
 * resourceful hosting, which no check covers, so the harness alone stops at 4.
 */
export function deployScoreFromHarness(r: HarnessResults): HarnessScore {
  const h = harness(r, ["U1", "R4", "R5", "R6", "R7"], ["U1"], () => {
    if (!passed(r, "U1")) return { score: 1, basis: "not deployed, or the health check fails" };
    const n = ["R4", "R5", "R6", "R7"].filter((k) => passed(r, k)).length;
    return { score: 2 + n * 0.75, basis: `deployed; ${n} of R4–R7 pass` };
  });
  return capForConfirmation(h, "the harness cannot check error monitoring, a rollback note or the hosting choice: confirm them to award above 4");
}

/**
 * Harness evidence for a planted fault: a passing check confirms the fix, a failing one
 * contradicts a claimed fix. found + pass → 1; found + fail → 0.5; missing + pass → 0.5
 * (fixed but not explained); otherwise the judge's credit stands.
 */
export function adjustFaultCredit(credit: number, checks: readonly string[], r: HarnessResults): { credit: number; reason: string | null } {
  const relevant = checks.filter((k) => ran(r, k));
  if (!relevant.length) return { credit, reason: null };
  const allPass = relevant.every((k) => passed(r, k));
  if (allPass && credit === 0) return { credit: 0.5, reason: `harness ${relevant.join("+")} passes, but the README does not explain the fix` };
  if (allPass && credit === 0.5) return { credit: 1, reason: `harness ${relevant.join("+")} confirms the fix` };
  if (!allPass && credit === 1) return { credit: 0.5, reason: `README claims a fix but harness ${relevant.filter((k) => !passed(r, k)).join("+")} fails` };
  return { credit, reason: null };
}

// ───────────────────────── Aggregation ─────────────────────────

export interface SubResult {
  final: number | null;
  spread: number | null;
  needsHumanReview: boolean;
  weight?: number;
}

export interface ParentResult {
  median: number | null;
  spread: number | null;
  needsHumanReview: boolean;
}

/**
 * Parent of subcriteria: median_score = (weighted) mean of the sub finals, spread = the largest
 * sub spread, needs review if any sub does. An optional cap (red flag) limits the score. Null
 * while any weighted sub has no final (e.g. no Loom to grade): a mean over the rest would hide it.
 */
export function aggregateParent(subs: readonly SubResult[], cap: number | null = null): ParentResult {
  const incomplete = subs.some((s) => (s.weight ?? 1) > 0 && s.final === null);
  const mean = incomplete ? null : weightedMean(subs.map((s) => ({ value: s.final, weight: s.weight ?? 1 })));
  const spreads = subs.map((s) => s.spread).filter((s): s is number => s !== null);
  const value = mean === null ? null : Math.round((cap !== null ? Math.min(mean, cap) : mean) * 100) / 100;
  return {
    median: value,
    spread: spreads.length ? Math.max(...spreads) : null,
    needsHumanReview: subs.some((s) => s.needsHumanReview) || subs.some((s) => s.final === null),
  };
}

/**
 * Stage score 0–100: Σ weight × criterionTo100(final) ÷ Σ weight, to 0.1. Null while any weighted
 * criterion has no final score: re-weighting over only the graded criteria would let a submission
 * whose repo could not be read (say) score 100 on its Loom alone. A person scores the missing
 * criterion (human override) and the score appears.
 */
export function stageScore(criteria: readonly { weight: number; final: number | null }[]): number | null {
  if (criteria.some((c) => c.weight > 0 && (c.final === null || !Number.isFinite(c.final)))) return null;
  const mean = weightedMean(criteria.map((c) => ({ value: c.final === null ? null : criterionTo100(c.final), weight: c.weight })));
  return mean === null ? null : Math.round(mean * 10) / 10;
}
