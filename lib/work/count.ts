import { WORDS_PER_PAGE } from "./stages";

/**
 * Word and page counting for work submissions (BA Part 1 word limit, SWE Test 2 page limit).
 * Run on sanitised text, so hidden characters cannot split or hide words.
 */

/** A word is a whitespace-separated token with at least one letter or digit (bullets and "|" don't count). */
export function countWords(text: string): number {
  let n = 0;
  for (const token of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(token)) n++;
  return n;
}

/** A line that starts an appendix: "Appendix A…", "## Appendix", "**Appendices**", "7. Appendix". */
const APPENDIX_LINE = /^[\s#>*_|-]*(?:\d+[.)]\s*)?appendi(?:x|ces)\b/i;
/** "Contents" / "Table of contents" on a line of its own (optionally a heading or bold). */
const CONTENTS_LINE = /^[\s#>*_|-]*(?:table\s+of\s+)?contents\s*[:*_]*\s*$/i;
/** A contents entry's page number: dot leaders, a tab, or 2+ spaces before a trailing number. */
const PAGE_REF = /(?:\.{3,}|…+|\t| {2,})\s*\d{1,3}\s*$/;
/** Contents entries are short; the first longer line ends the contents block. */
const TOC_MAX_WORDS = 12;
const TOC_MAX_LINES = 60;
/** A run of listed appendices ("Appendix A…", "Appendix B…" back to back) is a list, not the
 * start of the appendices, when at least this much ordinary text follows it… */
const LIST_FOLLOW_WORDS = 50;
/** …and it is repeated later, or sits in the first 30% of the document. */
const LIST_EARLY_SHARE = 0.3;

/** "Appendix A: Gap log" → "appendix a"; "Appendices" / "Appendix:" → "appendix". */
export function appendixKey(line: string): string {
  const m = line.toLowerCase().match(/appendi(?:x|ces)\b\s*(?:[-–—:.]\s*)?([a-z]\b|\d+\b|[ivx]+\b)?/);
  return m?.[1] ? `appendix ${m[1]}` : "appendix";
}

/** Heading text without numbering, markup, page references or case: for matching contents entries. */
function headingKey(line: string): string {
  return line
    .replace(PAGE_REF, "")
    .replace(/^[\s#>*_|-]*(?:\d+(?:\.\d+)*[.)]?\s*)?/, "")
    .replace(/[*_]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type BodySplit = {
  /** Everything before the first real appendix heading. */
  body: string;
  bodyWords: number;
  totalWords: number;
  /** Index of the line where the appendices start (null: no appendix). */
  cutLine: number | null;
  /** Appendix lines treated as contents/list entries rather than the start of the appendices. */
  listed: number[];
};

/**
 * Splits a memo into its body and appendices for the BA Part 1 word limit. The body ends at the
 * first line that starts with "Appendix", except lines that only LIST appendices:
 *   - entries inside a "Contents" / "Table of contents" block,
 *   - entries with a page number ("Appendix A: Gap log ........ 7"),
 *   - a run of back-to-back appendix lines naming two or more different appendices
 *     ("Appendix A: Gap log" then "Appendix B: Questions") that is followed by ordinary text,
 *     when the run is repeated later or sits in the first 30% of the document.
 */
export function splitBody(text: string): BodySplit {
  const lines = text.split(/\r?\n/);
  const isAppx = lines.map((l) => APPENDIX_LINE.test(l));
  const words = lines.map((l) => countWords(l));
  const before: number[] = [];
  let totalWords = 0;
  for (const w of words) {
    before.push(totalWords);
    totalWords += w;
  }
  const listed = new Set<number>();

  // 1. Contents blocks: short entries after a "Contents" line, until a longer line or a heading
  //    the contents already listed (the body has started).
  for (let i = 0; i < lines.length; i++) {
    if (!CONTENTS_LINE.test(lines[i])) continue;
    const seen = new Set<string>();
    for (let j = i + 1, n = 0; j < lines.length && n < TOC_MAX_LINES; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      n++;
      const key = headingKey(t);
      if (words[j] > TOC_MAX_WORDS || seen.has(key)) break;
      seen.add(key);
      if (isAppx[j]) listed.add(j);
    }
  }

  // 2. Entries with a page reference.
  lines.forEach((l, i) => {
    if (isAppx[i] && PAGE_REF.test(l)) listed.add(i);
  });

  // 3. Back-to-back appendix lines that list several appendices before more text.
  for (let i = 0; i < lines.length; ) {
    if (!isAppx[i] || listed.has(i)) {
      i++;
      continue;
    }
    const run = [i];
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || isAppx[j])) {
      if (isAppx[j]) run.push(j);
      j++;
    }
    const keys = new Set(run.map((k) => appendixKey(lines[k])).filter((k) => k !== "appendix"));
    if (run.length >= 2 && keys.size >= 2) {
      let follow = 0;
      for (let k = j; k < lines.length && !isAppx[k]; k++) follow += words[k];
      const later = new Set<string>();
      for (let k = j; k < lines.length; k++) if (isAppx[k]) later.add(appendixKey(lines[k]));
      const repeated = [...keys].some((k) => later.has(k));
      const early = before[i] <= LIST_EARLY_SHARE * totalWords;
      if (follow >= LIST_FOLLOW_WORDS && (repeated || early)) run.forEach((k) => listed.add(k));
    }
    i = j;
  }

  const cut = lines.findIndex((_, i) => isAppx[i] && !listed.has(i));
  const body = cut === -1 ? text : lines.slice(0, cut).join("\n");
  return {
    body,
    bodyWords: cut === -1 ? totalWords : countWords(body),
    totalWords,
    cutLine: cut === -1 ? null : cut,
    listed: [...listed].sort((a, b) => a - b),
  };
}

/** The memo body (see splitBody). */
export function bodyText(text: string): string {
  return splitBody(text).body;
}

/** Body word count: words before the first appendix heading (see splitBody). */
export function bodyWordCount(text: string): number {
  return splitBody(text).bodyWords;
}

/** Below this share of the whole document, a body under a word limit is implausibly small. */
export const MIN_BODY_SHARE = 0.25;

/**
 * True when the body only fits the limit because most of the document sits after the cut
 * (e.g. an early "Appendices: A gap log, B questions" line): a human should check the count.
 */
export function appendixShareSuspicious(split: Pick<BodySplit, "bodyWords" | "totalWords">, wordLimit: number | null): boolean {
  if (wordLimit === null || split.totalWords <= wordLimit) return false;
  return split.bodyWords < MIN_BODY_SHARE * split.totalWords;
}

/** Page estimate for DOCX/Markdown: ceil(words / 500); 0 for an empty document. */
export function estimatePages(words: number): number {
  return words > 0 ? Math.ceil(words / WORDS_PER_PAGE) : 0;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}
