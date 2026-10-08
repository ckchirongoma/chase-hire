import { liveWeights, rubricTo100, type LiveKey } from "@/lib/scoring/composite";

/**
 * Live-stage scorecards (docs/09 §2 and §5): pure helpers shared by the admin pages, the server
 * actions and the tests. Each rater scores every question 1–5 against behavioural anchors; the
 * card's total is the mean question score mapped onto 0–100 (1 → 0, 3 → 50, 5 → 100). Scores
 * sort and inform; the panel decides.
 */

/** Scorecard kinds that feed the live composite. The reasoning retest is separate (never scored). */
export const SCORED_KINDS: readonly LiveKey[] = ["panel_interview", "live_defence", "live_elicitation", "exec_scenario"];
export type ScoredKind = LiveKey;
export type ScorecardKind = ScoredKind | "reasoning_retest";

export const KIND_LABEL: Record<ScorecardKind, string> = {
  panel_interview: "Structured panel interview",
  live_defence: "Live defence of work",
  live_elicitation: "Live elicitation role-play",
  exec_scenario: "Exec scenario: Lerato asks for something unreasonable",
  reasoning_retest: "Reasoning retest (parallel form)",
};

export const isScoredKind = (k: string): k is ScoredKind => (SCORED_KINDS as readonly string[]).includes(k);

/** The scored live kinds for a role, in the docs/09 order (BA: panel, defence, elicitation; SWE: panel, defence, exec). */
export function kindsForRole(roleSlug: string): ScoredKind[] {
  const w = liveWeights(roleSlug);
  return SCORED_KINDS.filter((k) => (w[k] ?? 0) > 0);
}

export type Anchors = { "1": string; "3": string; "5": string };

export interface LiveQuestion {
  key: string;
  position: number;
  text: string;
  probes: string[];
  anchors: Anchors;
  /** Where the question came from: the bank, or the candidate's AI-interview verification concern. */
  source: "bank" | "concern";
}

export const SCORE_VALUES = [1, 2, 3, 4, 5] as const;
const isScore = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5;

/**
 * Keeps only scores for the card's questions, as integers 1–5. Returns what is missing and what
 * was out of range, so a draft can be partial but a submission must be complete.
 */
export function cleanScores(raw: Record<string, unknown>, keys: readonly string[]): { scores: Record<string, number>; missing: string[]; invalid: string[] } {
  const scores: Record<string, number> = {};
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const k of keys) {
    const v = raw[k];
    if (v === undefined || v === null || v === "") {
      missing.push(k);
      continue;
    }
    const n = typeof v === "string" ? Number(v) : v;
    if (isScore(n)) scores[k] = n;
    else invalid.push(k);
  }
  return { scores, missing, invalid };
}

/** Mean question score mapped to 0–100; null until every question has a score. */
export function scorecardTotal(scores: Record<string, number>, keys: readonly string[]): number | null {
  if (!keys.length) return null;
  const vals = keys.map((k) => scores[k]);
  if (!vals.every(isScore)) return null;
  return rubricTo100(vals.reduce((a, b) => a + b, 0) / vals.length);
}

// ───────────────────────── Notes ─────────────────────────
// live_scorecards.notes is one text column. Per-question notes are stored as "[key] note" blocks
// followed by the general notes, so the raw column stays readable on its own.

const GENERAL = "general";
const HEADER = /^\[([a-z0-9_]+)\]\s?/;

export function formatNotes(perQuestion: Record<string, string>, general: string, keys: readonly string[]): string | null {
  const blocks: string[] = [];
  for (const k of keys) {
    const t = perQuestion[k]?.trim();
    if (t) blocks.push(`[${k}] ${t}`);
  }
  const g = general.trim();
  if (g) blocks.push(blocks.length ? `[${GENERAL}] ${g}` : g);
  return blocks.length ? blocks.join("\n\n") : null;
}

/** Inverse of formatNotes. Text without any known header is all general notes. */
export function parseNotes(notes: string | null | undefined, keys: readonly string[]): { perQuestion: Record<string, string>; general: string } {
  const perQuestion: Record<string, string> = {};
  if (!notes?.trim()) return { perQuestion, general: "" };
  const known = new Set([...keys, GENERAL]);
  const general: string[] = [];
  let current: string | null = null;
  const parts: Record<string, string[]> = {};
  for (const line of notes.split("\n")) {
    const m = line.match(HEADER);
    if (m && known.has(m[1])) {
      current = m[1];
      parts[current] = [...(parts[current] ?? []), line.slice(m[0].length)];
    } else if (current) parts[current].push(line);
    else general.push(line);
  }
  for (const [k, lines] of Object.entries(parts)) {
    const text = lines.join("\n").trim();
    if (k === GENERAL) general.push(text);
    else if (text) perQuestion[k] = text;
  }
  return { perQuestion, general: general.join("\n").trim() };
}
