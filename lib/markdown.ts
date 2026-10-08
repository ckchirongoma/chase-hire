/**
 * A deliberately small markdown subset for admin-editable copy (job descriptions): "## " and "### "
 * headings, paragraphs, "- " bullets, "1. " numbered lists and **bold**. Anything else stays literal
 * text. It parses to plain data that components/markdown.tsx renders as React text, so there is no
 * HTML path at all: a stray "<script>" in the copy is shown, never run.
 */

export type Inline = { text: string; bold: boolean }[];

export type Block =
  | { type: "h2" | "h3" | "p"; inline: Inline }
  | { type: "ul" | "ol"; items: Inline[] };

export function parseInline(text: string): Inline {
  const out: Inline = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;

  const flush = () => {
    if (para.length) blocks.push({ type: "p", inline: parseInline(para.join(" ")) });
    if (list) blocks.push({ type: list.type, items: list.items.map(parseInline) });
    para = [];
    list = null;
  };

  for (const raw of src.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: heading[1].length === 3 ? "h3" : "h2", inline: parseInline(heading[2]) });
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.+)$/.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      const type = bullet ? "ul" : "ol";
      if (para.length || (list && list.type !== type)) flush();
      list ??= { type, items: [] };
      list.items.push(item[1]);
      continue;
    }
    // An indented line right after a list item continues that item; anything else is a paragraph.
    if (list && /^\s/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line}`;
      continue;
    }
    if (list) flush();
    para.push(line);
  }
  flush();
  return blocks;
}
