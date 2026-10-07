/**
 * Evidence-quote verification (hard rule 4): a grader's "verbatim" quote must actually appear
 * in the text it graded. Models drift on whitespace, curly quotes, dashes, case and elisions,
 * so both sides are normalised before matching. Anything still not found is flagged for a human.
 */

const ELLIPSIS = /\s*(?:\.{3,}|…|\[\s*\.{3}\s*\]|\[…\])\s*/g;

export function normaliseForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[​-‏⁠﻿­]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Strips wrapping quote marks and trailing/leading punctuation the model may add. */
function trimQuote(q: string): string {
  return q
    .trim()
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/^[,.;:!?\s-]+|[,.;:!?\s-]+$/g, "")
    .trim();
}

/**
 * True when the quote appears in `subject`. An elided quote ("a … b") matches when every
 * fragment appears in order. Empty quotes never match.
 */
export function quoteAppears(quote: string, subject: string): boolean {
  const hay = normaliseForMatch(subject);
  const fragments = normaliseForMatch(quote)
    .split(ELLIPSIS)
    .map(trimQuote)
    .filter((f) => f.length > 0);
  if (!fragments.length) return false;
  let from = 0;
  for (const f of fragments) {
    const at = hay.indexOf(f, from);
    if (at < 0) return false;
    from = at + f.length;
  }
  return true;
}

/** Returns the quotes that could NOT be found in the subject text. */
export function unverifiedQuotes(evidence: readonly { quote: string }[], subject: string): string[] {
  return evidence.map((e) => e.quote).filter((q) => !quoteAppears(q, subject));
}
