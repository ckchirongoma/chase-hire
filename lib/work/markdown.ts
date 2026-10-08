import { createElement, Fragment, type ReactNode } from "react";

/**
 * A deliberately tiny Markdown renderer for stage briefs: headings, paragraphs, (nested) lists,
 * blockquotes, **bold**, *italic* / _italic_ and `inline code`. Everything else is plain text.
 *
 * It builds React elements, so every piece of text is escaped by React; there is no HTML
 * pass-through and no dangerouslySetInnerHTML. Links and images are intentionally not supported.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] };

export type ListItem = { inline: Inline[]; children: Block[] };

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inline: Inline[] }
  | { type: "paragraph"; inline: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "blockquote"; children: Block[] };

// ───────────────────────── Inline ─────────────────────────

function pushText(out: Inline[], text: string) {
  if (!text) return;
  const prev = out[out.length - 1];
  if (prev?.type === "text") prev.text += text;
  else out.push({ type: "text", text });
}

/** Finds the closing delimiter that is not escaped and (for emphasis) not preceded by a space. */
function findClose(s: string, delim: string, from: number): number {
  for (let i = from; i <= s.length - delim.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (delim.length === 1 && s[i] === delim && s[i + 1] === delim) {
      while (s[i + 1] === delim) i++; // a "**" run belongs to a strong span, not this "*"
      continue;
    }
    if (s.startsWith(delim, i) && i > from && s[i - 1] !== " ") return i;
  }
  return -1;
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

function matchStrong(s: string, i: number): { inner: string; end: number } | null {
  for (const d of ["**", "__"]) {
    if (!s.startsWith(d, i) || !s[i + 2] || s[i + 2] === " ") continue;
    if (d === "__" && isWordChar(s[i - 1])) continue;
    const end = findClose(s, d, i + 2);
    if (end === -1 || (d === "__" && isWordChar(s[end + 2]))) continue;
    return { inner: s.slice(i + 2, end), end: end + 2 };
  }
  return null;
}

function matchEm(s: string, i: number): { inner: string; end: number } | null {
  const c = s[i];
  if (c !== "*" && c !== "_") return null;
  if (!s[i + 1] || s[i + 1] === " " || s[i + 1] === c) return null;
  if (c === "_" && isWordChar(s[i - 1])) return null; // snake_case stays text
  const end = findClose(s, c, i + 1);
  if (end === -1 || (c === "_" && isWordChar(s[end + 1]))) return null;
  return { inner: s.slice(i + 1, end), end: end + 1 };
}

export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && /[\\`*_#>\-+.!|[\]()]/.test(s[i + 1])) {
      pushText(out, s[i + 1]);
      i += 2;
      continue;
    }
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) {
        out.push({ type: "code", text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (depth < 4) {
      const strong = matchStrong(s, i);
      if (strong) {
        out.push({ type: "strong", children: parseInline(strong.inner, depth + 1) });
        i = strong.end;
        continue;
      }
      const em = matchEm(s, i);
      if (em) {
        out.push({ type: "em", children: parseInline(em.inner, depth + 1) });
        i = em.end;
        continue;
      }
    }
    pushText(out, c);
    i++;
  }
  return out;
}

// ───────────────────────── Blocks ─────────────────────────

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

const indentOf = (line: string) => line.match(/^\s*/)![0].replace(/\t/g, "    ").length;
const isBlank = (line: string) => line.trim() === "";

function startsBlock(line: string): boolean {
  return HEADING.test(line) || LIST_ITEM.test(line) || QUOTE.test(line);
}

function parseLines(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length as 1 | 2 | 3 | 4 | 5 | 6, inline: parseInline(h[2]) });
      i++;
      continue;
    }

    if (QUOTE.test(line) && depth < 8) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].match(QUOTE)![1]);
      blocks.push({ type: "blockquote", children: parseLines(inner, depth + 1) });
      continue;
    }

    const li = line.match(LIST_ITEM);
    if (li && depth < 8) {
      const base = indentOf(line);
      const ordered = /\d/.test(li[2]);
      const items: ListItem[] = [];
      const start = ordered ? Number.parseInt(li[2], 10) : 1;
      while (i < lines.length) {
        if (isBlank(lines[i])) {
          let j = i;
          while (j < lines.length && isBlank(lines[j])) j++;
          const sib = j < lines.length ? lines[j].match(LIST_ITEM) : null;
          if (!sib || indentOf(lines[j]) !== base || /\d/.test(sib[2]) !== ordered) break;
          i = j;
        }
        const m = lines[i].match(LIST_ITEM);
        if (!m || indentOf(lines[i]) !== base || /\d/.test(m[2]) !== ordered) break;
        const contentIndent = base + m[2].length + 1;
        const text: string[] = [m[3]];
        const childLines: string[] = [];
        i++;
        // Lazy continuation lines join the item's text; deeper-indented lines are its children.
        while (i < lines.length) {
          const next = lines[i];
          if (isBlank(next)) {
            const after = lines.slice(i + 1).find((l) => !isBlank(l));
            if (after !== undefined && indentOf(after) > base) {
              childLines.push("");
              i++;
              continue;
            }
            break;
          }
          const ind = indentOf(next);
          if (ind > base && (childLines.length || LIST_ITEM.test(next))) {
            childLines.push(next.slice(Math.min(ind, contentIndent)));
            i++;
            continue;
          }
          if (ind > base || (!startsBlock(next) && !childLines.length)) {
            if (ind <= base && LIST_ITEM.test(next)) break;
            text.push(next.trim());
            i++;
            continue;
          }
          break;
        }
        items.push({ inline: parseInline(text.join(" ")), children: parseLines(childLines, depth + 1) });
      }
      blocks.push({ type: "list", ordered, start, items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines[i]))) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", inline: parseInline(para.join(" ")) });
  }
  return blocks;
}

export function parseMarkdown(src: string): Block[] {
  return parseLines(String(src ?? "").replace(/\r\n?/g, "\n").split("\n"), 0);
}

// ───────────────────────── React ─────────────────────────

const HEADING_CLASS: Record<number, string> = {
  1: "text-xl font-semibold",
  2: "text-lg font-semibold",
  3: "text-base font-semibold",
  4: "text-sm font-semibold",
  5: "text-sm font-semibold",
  6: "text-sm font-semibold",
};

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, k) => {
    switch (n.type) {
      case "text":
        return createElement(Fragment, { key: k }, n.text);
      case "code":
        return createElement("code", { key: k, className: "rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em]" }, n.text);
      case "strong":
        return createElement("strong", { key: k }, ...renderInline(n.children));
      case "em":
        return createElement("em", { key: k }, ...renderInline(n.children));
    }
  });
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((b, k) => {
    switch (b.type) {
      case "heading":
        return createElement(`h${Math.min(6, b.level + 1)}`, { key: k, className: HEADING_CLASS[b.level] }, ...renderInline(b.inline));
      case "paragraph":
        return createElement("p", { key: k }, ...renderInline(b.inline));
      case "blockquote":
        return createElement("blockquote", { key: k, className: "space-y-2 border-l-4 border-slate-200 pl-4 text-slate-700" }, ...renderBlocks(b.children));
      case "list":
        return createElement(
          b.ordered ? "ol" : "ul",
          {
            key: k,
            className: `${b.ordered ? "list-decimal" : "list-disc"} space-y-1 pl-6`,
            ...(b.ordered && b.start !== 1 ? { start: b.start } : {}),
          },
          ...b.items.map((item, j) =>
            createElement("li", { key: j }, ...renderInline(item.inline), ...(item.children.length ? [createElement("div", { key: "c", className: "mt-1 space-y-1" }, ...renderBlocks(item.children))] : [])),
          ),
        );
    }
  });
}

/** Renders Markdown as React elements (all text escaped by React). */
export function renderMarkdown(src: string): ReactNode {
  return createElement("div", { className: "space-y-3 text-sm leading-relaxed" }, ...renderBlocks(parseMarkdown(src)));
}
