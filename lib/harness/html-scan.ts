/**
 * Linear-time helpers for reading the candidate's HTML (pages up to a few MB, possibly hostile).
 * Regexes such as `<a\b[^>]*>([\s\S]*?)<\/a>` rescan to the end of the page for every unclosed
 * tag, which is quadratic: a page of unclosed tags would stall a run past the route's
 * maxDuration. These helpers find every tag end and closing tag with memoised forward searches,
 * so each page is read in one pass.
 */

export interface Tag {
  /** Lower-cased tag name. */
  name: string;
  start: number;
  /** Index just after the tag's ">". */
  end: number;
  /** The start tag, "<a href=…>". */
  raw: string;
}

export interface Element {
  tag: Tag;
  /** What is between the start tag and the closing tag. */
  inner: string;
  /** Index just after the closing tag. */
  end: number;
}

const TAG_START = /<([a-zA-Z][a-zA-Z0-9-]{0,30})(?=[\s/>])/g;

/** Start tags with one of `names`, in document order. Tags longer than `maxTagLength` are skipped. */
export function startTags(html: string, names: readonly string[], maxTagLength = 16_000): Tag[] {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const out: Tag[] = [];
  // The first ">" at or after the last search start; valid for every later tag start before it.
  let gt = -1;
  for (const m of html.matchAll(TAG_START)) {
    const start = m.index ?? 0;
    if (gt < start) {
      gt = html.indexOf(">", start);
      if (gt < 0) break;
    }
    const name = m[1].toLowerCase();
    if (!want.has(name) || gt - start > maxTagLength) continue;
    out.push({ name, start, end: gt + 1, raw: html.slice(start, gt + 1) });
  }
  return out;
}

/**
 * Elements `<name …>inner</name>`, like the lazy regex: each start tag pairs with the first
 * closing tag after it, and start tags inside a matched element are skipped. Elements whose inner
 * text is longer than `maxInner` are skipped.
 */
export function elements(html: string, name: string, maxInner = 500_000): Element[] {
  const out: Element[] = [];
  const close = new RegExp(`</${name}\\s*>`, "gi");
  let closeAt = -1;
  let closeEnd = -1;
  let after = 0;
  for (const tag of startTags(html, [name])) {
    if (tag.start < after) continue;
    if (closeAt < tag.end) {
      close.lastIndex = tag.end;
      const m = close.exec(html);
      if (!m) break; // no closing tag anywhere after this point
      closeAt = m.index;
      closeEnd = m.index + m[0].length;
    }
    after = closeEnd;
    if (closeAt - tag.end > maxInner) continue;
    out.push({ tag, inner: html.slice(tag.end, closeAt), end: closeEnd });
  }
  return out;
}

/** Replaces tags with spaces (each "<" scans only to the next "<" or ">"). */
export const stripTags = (s: string) => s.replace(/<[^<>]*>/g, " ");

/** Removes <!-- comments --> (an unclosed comment runs to the end, as in a browser). */
export function stripComments(s: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const a = s.indexOf("<!--", i);
    if (a < 0) break;
    out += s.slice(i, a);
    const b = s.indexOf("-->", a + 4);
    if (b < 0) return out;
    i = b + 3;
  }
  return out + s.slice(i);
}
