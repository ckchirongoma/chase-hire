/**
 * Server-side scrub for candidate-visible feedback (grade_summaries.feedback, shown by
 * my_results()). Judges see INTERNAL reference material (answer keys, bundle figures, red flags),
 * and only prompt wording asks them not to repeat it, so every summary feedback passes through
 * here before it is stored. Feedback that mentions an answer-key id, a red flag, a harness check,
 * reference/proposal wording, or a number equal to an internal figure is withheld (null). Losing a
 * sentence of feedback is cheap; leaking an answer key to a candidate pool is not.
 */

export interface FeedbackSecrets {
  /** Internal ids matched as whole words, case-insensitively (D01, H03, A04, F13, crawler, M5, ...). */
  terms?: readonly string[];
  /** Internal numbers (bundle figures, internal prices). Integers below 10 are ignored as too common. */
  numbers?: readonly number[];
}

/** Answer-key id shapes: D01–D23, H01–H14, A01–A15, F01–F14. */
const KEY_ID = /\b[DHAF]\d{2}\b/i;

const INTERNAL_WORDING: readonly RegExp[] = [
  /\banswer[\s-]*keys?\b/i,
  /\breference\s+(?:answers?|prices?|keys?|mappings?|solutions?|figures?|ranges?|points?)\b/i,
  /\bREFERENCE\b/,
  /\bproposals?\b/i,
  /\bgold[\s-]*(?:standard|answers?|samples?|reference)\b/i,
  /\binternal\s+(?:reference|prices?|keys?|answers?|figures?|notes?|estimates?)\b/i,
  /\bhidden\s+facts?\b/i,
  /\bplanted\b/i,
  /\bgeneric\s+baseline\b/i,
  /\bbundle\b/i,
  /\bred[\s-]*flags?\b/i,
  /\bverification\s+harness\b/i,
];

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every number written in the text, with k/m suffixes and thousands separators resolved. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  const re = /(\d{1,3}(?:[ , ]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(k|m|bn)?(?![\w])/gi;
  for (const m of text.matchAll(re)) {
    const base = Number(m[1].replace(/[ , ]/g, ""));
    if (!Number.isFinite(base)) continue;
    const mult = m[2] ? ({ k: 1e3, m: 1e6, bn: 1e9 } as Record<string, number>)[m[2].toLowerCase()] : 1;
    out.push(base * mult);
  }
  return out;
}

const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.05, Math.abs(b) * 1e-6);

/** Returns the feedback, or null with the reason when it would reveal internal material. */
export function scrubFeedback(feedback: string | null | undefined, secrets: FeedbackSecrets = {}): { text: string | null; reason: string | null } {
  const text = feedback?.trim() ?? "";
  if (!text) return { text: null, reason: null };
  if (KEY_ID.test(text)) return { text: null, reason: "mentions an answer-key id" };
  for (const re of INTERNAL_WORDING) if (re.test(text)) return { text: null, reason: `mentions internal material (${re.source})` };
  const terms = (secrets.terms ?? []).filter((t) => t.trim().length > 1);
  if (terms.length) {
    const termRe = new RegExp(`(?:^|[^\\w])(${terms.map((t) => escapeRe(t).replace(/_/g, "[_\\s-]?")).join("|")})(?=$|[^\\w])`, "i");
    const hit = text.match(termRe);
    if (hit) return { text: null, reason: `mentions an internal id (${hit[1]})` };
  }
  const secretNumbers = (secrets.numbers ?? []).filter((n) => Number.isFinite(n) && (!Number.isInteger(n) || Math.abs(n) >= 10));
  if (secretNumbers.length) {
    for (const n of numbersIn(text)) {
      if (secretNumbers.some((s) => same(n, s))) return { text: null, reason: `quotes an internal figure (${n})` };
    }
  }
  return { text, reason: null };
}

/** Collects the numeric leaves of a reference block (e.g. internal_reference_price). */
export function numericLeaves(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  else if (Array.isArray(value)) for (const v of value) numericLeaves(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) numericLeaves(v, out);
  return out;
}
