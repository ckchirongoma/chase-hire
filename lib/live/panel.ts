import type { Anchors, LiveQuestion } from "./scorecard";

/**
 * Structured panel interview (docs/09 §5): 6 questions per role, fixed, with standard probes and
 * 1/3/5 behavioural anchors. Two of the six are drawn from the candidate's AI-interview
 * verification_concerns (docs/05): each concern replaces one "replaceable" bank question, in
 * position order. With fewer than two concerns the bank question stays in that slot.
 */

export const PANEL_SIZE = 6;
export const CONCERN_SLOTS = 2;

export interface BankQuestion {
  key: string;
  position: number;
  text: string;
  probes: string[];
  anchors: Anchors;
  replaceable: boolean;
  active?: boolean;
}

export interface Concern {
  claim: string;
  reason: string;
}

const MAX_CLAIM = 300;
const MAX_REASON = 400;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Concerns from interview_sessions.summary (LLM output: untrusted shape). Keeps well-formed
 * {claim, reason} entries with a non-empty claim, de-duplicated by claim (case-insensitive).
 */
export function normaliseConcerns(raw: unknown): Concern[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Concern[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const claim = typeof (c as { claim?: unknown }).claim === "string" ? oneLine((c as { claim: string }).claim) : "";
    const reason = typeof (c as { reason?: unknown }).reason === "string" ? oneLine((c as { reason: string }).reason) : "";
    if (!claim) continue;
    const id = claim.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ claim: clip(claim, MAX_CLAIM), reason: clip(reason, MAX_REASON) });
  }
  return out;
}

/** Standard probes for a verification question (the same for every candidate). */
export const CONCERN_PROBES: readonly string[] = [
  "What exactly did you personally do, and what did others do?",
  "Which tools or systems, and what numbers and dates?",
  "What went wrong, and how did you find out?",
  "How does this fit with the dates and roles on your CV?",
];

export const CONCERN_ANCHORS: Anchors = {
  "1": "Can't substantiate the claim: vague, contradicts the CV, or describes someone else's work",
  "3": "Some specifics (tools, rough numbers), but ownership or depth is thin under probing; the concern is only partly resolved",
  "5": "Specific and consistent with the CV; gets more specific under probing (systems, numbers, dates, what went wrong); the concern is resolved with checkable detail",
};

/**
 * A verification question's key, from the claim itself (FNV-1a of the lower-cased claim), so a
 * score saved against it stays with that claim even if the AI-interview summary is re-graded and
 * its concerns change order.
 */
export function concernKey(claim: string): string {
  let h = 0x811c9dc5;
  for (const ch of oneLine(claim).toLowerCase()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193);
  }
  return `concern_${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export const isConcernKey = (key: string) => /^concern_[0-9a-f]{8}(_\d)?$/.test(key);

export function concernQuestion(concern: Concern, position: number): LiveQuestion {
  const reason = concern.reason ? ` The AI interview noted: ${concern.reason}` : "";
  return {
    key: concernKey(concern.claim),
    position,
    text: `Verification: your CV or interview said "${concern.claim}".${reason} Walk us through exactly what you did, with the tools, numbers and dates.`,
    probes: [...CONCERN_PROBES],
    anchors: { ...CONCERN_ANCHORS },
    source: "concern",
  };
}

const asQuestion = (q: BankQuestion): LiveQuestion => ({
  key: q.key,
  position: q.position,
  text: q.text,
  probes: [...q.probes],
  anchors: { ...q.anchors },
  source: "bank",
});

/**
 * The panel scorecard for one candidate: the role's active bank questions (by position, at most 6)
 * with up to two replaced by verification questions. Replacement goes to the "replaceable" slots in
 * position order; a bank with fewer replaceable slots than concerns falls back to its last
 * questions, so two concerns always reach the panel.
 */
export function assemblePanel(bank: readonly BankQuestion[], concerns: readonly Concern[]): LiveQuestion[] {
  const questions = bank
    .filter((q) => q.active !== false)
    .slice()
    .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))
    .slice(0, PANEL_SIZE);
  const wanted = Math.min(CONCERN_SLOTS, concerns.length, questions.length);
  const slots = questions.map((q, i) => ({ q, i })).filter(({ q }) => q.replaceable).map(({ i }) => i);
  for (let i = questions.length - 1; slots.length < wanted && i >= 0; i--) if (!slots.includes(i)) slots.push(i);
  const chosen = slots.slice(0, wanted).sort((a, b) => a - b);

  const out = questions.map(asQuestion);
  chosen.forEach((slot, n) => {
    const q = concernQuestion(concerns[n], questions[slot].position);
    // Two different claims hashing alike (vanishingly rare) still get distinct keys.
    out[slot] = out.some((o) => o.key === q.key) ? { ...q, key: `${q.key}_${n + 1}` } : q;
  });
  return out;
}

/** Bank questions for the other scored kinds: active, in position order. */
export function bankQuestions(bank: readonly BankQuestion[]): LiveQuestion[] {
  return bank
    .filter((q) => q.active !== false)
    .slice()
    .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))
    .map(asQuestion);
}
