import zlib from "node:zlib";

/**
 * A minimal, dependency-free .xlsx reader for the harness: the first worksheet's cell text as
 * rows. Enough for the bundle's own spreadsheets (optouts_legal.xlsx for U7); not a general
 * parser (no formulas evaluated, dates come back as their serial numbers).
 */

const MAX_ENTRY_BYTES = 20 * 1024 * 1024;

/** The files in a zip archive (stored or deflated entries), by name. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end of central directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    if (size > MAX_ENTRY_BYTES) continue;
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }));
  }
  return out;
}

const xmlText = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#\d+);/gi, (m, e: string) => {
    const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
    if (named[e.toLowerCase()]) return named[e.toLowerCase()];
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });

/** All <t> text inside a fragment (rich-text runs joined). */
const allText = (frag: string) => [...frag.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1])).join("");

function columnIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** The first worksheet as rows of cell text ("" for empty cells). */
export function readFirstSheet(buf: Buffer): string[][] {
  const files = unzip(buf);
  const text = (name: string) => files.get(name)?.toString("utf8") ?? null;
  const shared = [...(text("xl/sharedStrings.xml") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => allText(m[1]));

  // The first <sheet> in workbook.xml, through its relationship, else sheet1.xml.
  let sheetPath = "xl/worksheets/sheet1.xml";
  const firstRid = text("xl/workbook.xml")?.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
  const rels = text("xl/_rels/workbook.xml.rels");
  if (firstRid && rels) {
    const target = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${firstRid}"`))?.match(/Target="([^"]+)"/)?.[1];
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheet = text(sheetPath);
  if (!sheet) throw new Error(`no worksheet at ${sheetPath}`);

  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNo = Number(rm[1].match(/\br="(\d+)"/)?.[1] ?? rows.length + 1);
    const cells: string[] = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = attrs.match(/\br="([A-Z]+)\d+"/i)?.[1] ?? "";
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? "n";
      const inner = cm[2] ?? "";
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = "";
      if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = allText(inner);
      else if (v !== undefined) value = xmlText(v);
      const idx = ref ? columnIndex(ref) : cells.length;
      while (cells.length < idx) cells.push("");
      cells[idx] = value;
    }
    while (rows.length < rowNo - 1) rows.push([]);
    rows[rowNo - 1] = cells;
  }
  return rows;
}
