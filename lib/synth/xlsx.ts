import { Workbook, type Worksheet } from "exceljs";

/**
 * exceljs helpers for the synthetic bundles. Cell TYPES are part of the planted defects
 * (numbers vs strings vs real dates vs errors), so values are written exactly as given.
 * exceljs is a devDependency: only scripts/ and tests import this module.
 */

export type CellIn = string | number | Date | null | { error: "#VALUE!" | "#N/A" };

/** Fixed workbook metadata so re-running a seed gives the same file content. */
const FIXED = new Date(Date.UTC(2026, 9, 7, 6, 0, 0));

export function newWorkbook(creator: string): Workbook {
  const wb = new Workbook();
  wb.creator = creator;
  wb.lastModifiedBy = creator;
  wb.created = FIXED;
  wb.modified = FIXED;
  return wb;
}

export interface SheetSpec {
  name: string;
  /** null = a column with no header (e.g. the worksheet's notes column F). */
  headers: (string | null)[];
  rows: CellIn[][];
  /** Excel number format per column index (0-based) for Date cells; default yyyy-mm-dd. */
  dateFormats?: Record<number, string>;
  widths?: number[];
}

export function addSheet(wb: Workbook, spec: SheetSpec): Worksheet {
  const ws = wb.addWorksheet(spec.name);
  ws.addRow(spec.headers.map((h) => (h === null ? null : h)));
  ws.getRow(1).font = { bold: true };
  for (const r of spec.rows) {
    const row = ws.addRow(r.map((v) => (v === undefined ? null : v)));
    r.forEach((v, i) => {
      if (v instanceof Date) row.getCell(i + 1).numFmt = spec.dateFormats?.[i] ?? "yyyy-mm-dd";
    });
  }
  spec.widths?.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  return ws;
}

export async function workbookBuffer(wb: Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ───────────────────────── Reading back ─────────────────────────

export type CellOut = string | number | Date | null | { error: string } | boolean;

/** Plain cell value (rich text flattened, formulas → result). */
export function plain(v: unknown): CellOut {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v instanceof Date) return v;
  if (typeof v === "object") {
    const o = v as { richText?: { text: string }[]; result?: unknown; error?: string; text?: string };
    if (o.richText) return o.richText.map((t) => t.text).join("");
    if (o.error) return { error: o.error };
    if ("result" in o) return plain(o.result);
    if (typeof o.text === "string") return o.text;
  }
  return String(v);
}

export interface ReadSheet {
  name: string;
  headers: (string | null)[];
  /** Data rows, each with its Excel row number (header = row 1). */
  rows: { rowNumber: number; cells: CellOut[] }[];
}

export async function readWorkbook(input: Buffer | string): Promise<Map<string, ReadSheet>> {
  const wb = new Workbook();
  if (typeof input === "string") await wb.xlsx.readFile(input);
  else await wb.xlsx.load(input as unknown as ArrayBuffer);
  const out = new Map<string, ReadSheet>();
  wb.eachSheet((ws) => {
    const width = ws.columnCount;
    const header = ws.getRow(1);
    const headers = Array.from({ length: width }, (_, i) => {
      const v = plain(header.getCell(i + 1).value);
      return v === null || v === "" ? null : String(v);
    });
    const rows: ReadSheet["rows"] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      rows.push({ rowNumber: r, cells: Array.from({ length: width }, (_, i) => plain(row.getCell(i + 1).value)) });
    }
    out.set(ws.name, { name: ws.name, headers, rows });
  });
  return out;
}

/** Column index by exact header text (trailing spaces matter). */
export function col(sheet: ReadSheet, header: string | null): number {
  const i = sheet.headers.findIndex((h) => h === header);
  if (i < 0) throw new Error(`column "${header}" not found in "${sheet.name}"`);
  return i;
}
