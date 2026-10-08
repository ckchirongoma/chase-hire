import ExcelJS from "exceljs";
import type { Cell } from "./normalise";

export interface SheetRow {
  /** Excel row number (the header is row 1). */
  rowNumber: number;
  cells: Record<string, Cell>;
}

export interface Sheet {
  name: string;
  headers: string[];
  rows: SheetRow[];
}

/** A plain value for one cell: rich text flattened, formulas resolved to their result. */
function plain(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v instanceof Date) return v;
  if (typeof v === "object") {
    const o = v as { richText?: { text: string }[]; result?: unknown; text?: string; error?: string };
    if (o.richText) return o.richText.map((t) => t.text).join("");
    if (o.error) return null;
    if ("result" in o) return plain(o.result);
    if (typeof o.text === "string") return o.text;
  }
  return String(v);
}

/** Every sheet in an .xlsx file, with rows keyed by their (trimmed) header text. */
export async function readWorkbook(buffer: ArrayBuffer | Buffer): Promise<Sheet[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as ArrayBuffer);
  } catch {
    throw new Error("The file could not be read as an Excel workbook (.xlsx).");
  }
  const sheets: Sheet[] = [];
  wb.eachSheet((ws) => {
    const width = ws.columnCount;
    const headerRow = ws.getRow(1);
    const headers = Array.from({ length: width }, (_, i) => {
      const v = plain(headerRow.getCell(i + 1).value);
      return v === null ? "" : String(v).trim();
    });
    const rows: SheetRow[] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells: Record<string, Cell> = {};
      let any = false;
      headers.forEach((h, i) => {
        const v = plain(row.getCell(i + 1).value);
        if (v !== null && v !== "") any = true;
        if (h) cells[h] = v;
      });
      if (any) rows.push({ rowNumber: r, cells });
    }
    sheets.push({ name: ws.name, headers, rows });
  });
  return sheets;
}
