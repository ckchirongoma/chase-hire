import { OPTOUT_COLUMNS, checkColumns } from "./columns";
import { normaliseCompanyName, parseDate, rawValue, text } from "./normalise";
import { ImportApplyError, sha256Hex, type Db, type ImportResult, type QuarantineRow } from "./types";
import { readWorkbook } from "./xlsx";

/**
 * Legal's opt-out list (RD-11). It names companies only, so each entry is stored with its
 * normalised name and matched to customers in the database (exact name, then a unique near match).
 */

export interface PlannedOptout {
  row_number: number;
  company_name: string;
  normalised_name: string;
  status: "opted_out" | "legal_review";
  reason: string | null;
  logged_on: string | null;
}

const STATUS: Record<string, PlannedOptout["status"]> = {
  "opted out": "opted_out",
  "opt out": "opted_out",
  "opted-out": "opted_out",
  "do not contact": "opted_out",
  "under legal review": "legal_review",
  "legal review": "legal_review",
};

export function planOptoutsImport(sheetHeaders: string[], rows: { rowNumber: number; cells: Record<string, unknown> }[]) {
  checkColumns(sheetHeaders, OPTOUT_COLUMNS, "opt-out list");
  const optouts: PlannedOptout[] = [];
  const quarantine: QuarantineRow[] = [];
  for (const row of rows) {
    const c = row.cells as Record<string, string | number | Date | null>;
    const raw = Object.fromEntries(OPTOUT_COLUMNS.map((k) => [k, rawValue(c[k])]));
    const company = text(c["Company"]);
    if (!company || normaliseCompanyName(company).length < 3) {
      quarantine.push({ row_number: row.rowNumber, reason: "missing_company", detail: "Company is blank", raw });
      continue;
    }
    const statusText = (text(c["Status"]) ?? "").toLowerCase();
    // Anything Legal lists is treated as do-not-contact; an unknown status is reported, not ignored.
    const status = STATUS[statusText] ?? "opted_out";
    if (!STATUS[statusText]) quarantine.push({ row_number: row.rowNumber, reason: "unknown_status", detail: `Status "${text(c["Status"]) ?? ""}" is not recognised; treated as opted out`, raw });
    const logged = parseDate(c["Date Logged"]);
    optouts.push({
      row_number: row.rowNumber,
      company_name: company,
      normalised_name: normaliseCompanyName(company),
      status,
      reason: text(c["Notes"]),
      logged_on: logged.ok ? logged.date : null,
    });
  }
  return { optouts, quarantine, stats: { listed_rows: rows.length } };
}

export async function importOptoutsFile(db: Db, fileName: string, buffer: ArrayBuffer | Buffer): Promise<ImportResult> {
  const sheets = await readWorkbook(buffer);
  const sheet = sheets.find((s) => OPTOUT_COLUMNS.every((c) => s.headers.includes(c))) ?? sheets[0];
  if (!sheet) throw new ImportApplyError("The workbook has no sheets.");
  const plan = planOptoutsImport(sheet.headers, sheet.rows);
  const { data, error } = await db.rpc("import_optouts", {
    p_file_name: fileName,
    p_file_sha256: await sha256Hex(buffer),
    p_rows: plan.optouts,
    p_quarantine: plan.quarantine,
  });
  if (error) throw new ImportApplyError(error.message, error.code);
  const result = data as { run_id: string; counts: Record<string, unknown> };
  return { runId: result.run_id, kind: "optouts", fileName, counts: { ...plan.stats, ...result.counts }, quarantine: plan.quarantine };
}
