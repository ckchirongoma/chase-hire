import { BASE_COLUMNS, checkColumns } from "./columns";
import { idText, integer, money, normaliseCompanyName, normalisePhone, parseDate, rawValue, text, type Cell, type NumberType } from "./normalise";
import { ImportApplyError, sha256Hex, type Db, type ImportResult, type QuarantineRow } from "./types";
import { readWorkbook, type Sheet, type SheetRow } from "./xlsx";

/**
 * The monthly base import (one row per phone line). Parsing and normalising happen here, in
 * plain functions; public.import_base() then applies the clean rows in one transaction.
 */

export interface PlannedAccount {
  account_no: string;
  reg_no: string | null;
  legal_name: string;
  normalised_name: string;
  segment: string | null;
  dealer_code: string | null;
}

export interface PlannedLine {
  row_number: number;
  account_no: string;
  msisdn_e164: string;
  number_type: NumberType;
  priceplan: string | null;
  priceplan_name: string | null;
  term_months: number | null;
  contract_end_date: string | null;
  /** False when the file's end date could not be trusted: the line keeps its previous date. */
  end_date_trusted: boolean;
  device: string | null;
  monthly_charge_zar: number | null;
  /** The export's own status column, kept only to report how stale it is. */
  export_status: string | null;
}

export interface BasePlan {
  accounts: PlannedAccount[];
  lines: PlannedLine[];
  /** Every line the file mentions, including rows quarantined for other reasons. */
  seen: string[];
  quarantine: QuarantineRow[];
  stats: Record<string, number>;
}

const SHEET_NAME = "vsam base raw";

function rawRow(row: SheetRow): QuarantineRow["raw"] {
  return Object.fromEntries(BASE_COLUMNS.map((c) => [c, rawValue(row.cells[c])]));
}

function device(type: Cell | undefined, model: Cell | undefined): string | null {
  const parts = [text(type), text(model)].filter(Boolean);
  return parts.length ? parts.join(": ") : null;
}

/** Picks the base sheet: the one named like the export, else the only sheet. */
export function baseSheet(sheets: Sheet[]): Sheet {
  const named = sheets.find((s) => s.name.trim().toLowerCase() === SHEET_NAME);
  if (named) return named;
  if (sheets.length === 1) return sheets[0];
  throw new ImportApplyError(`The workbook has ${sheets.length} sheets and none is called "${SHEET_NAME}".`);
}

/** Turns the export's rows into accounts, lines and a quarantine report. Pure. */
export function planBaseImport(sheet: Sheet): BasePlan {
  checkColumns(sheet.headers, BASE_COLUMNS, "base export");
  const accounts = new Map<string, PlannedAccount>();
  const lines = new Map<string, PlannedLine>();
  const fingerprints = new Map<string, string>();
  const seen = new Set<string>();
  const quarantine: QuarantineRow[] = [];
  const stats = { file_rows: sheet.rows.length, duplicate_rows: 0, conflicting_rows: 0, landlines: 0, stale_export_status_rows: 0, quarantined_rows: 0 };
  const today = new Date().toISOString().slice(0, 10);
  const flagged = new Set<number>();
  const flag = (row: SheetRow, reason: string, detail: string) => {
    quarantine.push({ row_number: row.rowNumber, reason, detail, raw: rawRow(row) });
    flagged.add(row.rowNumber);
  };

  for (const row of sheet.rows) {
    const c = row.cells;
    // Exact repeats of an earlier row change nothing: count them and move on.
    const fingerprint = JSON.stringify(BASE_COLUMNS.map((k) => rawValue(c[k])));
    if (fingerprints.has(fingerprint)) {
      stats.duplicate_rows++;
      continue;
    }
    fingerprints.set(fingerprint, String(row.rowNumber));

    const phone = normalisePhone(c["Msisdn"]);
    if (!phone.ok) {
      flag(row, "invalid_phone", `Msisdn ${phone.reason}: the line cannot be identified`);
      continue;
    }
    seen.add(phone.e164);

    const accountNo = idText(c["Account No"]);
    const name = text(c["Customer Name"]);
    if (!accountNo || !name) {
      flag(row, !accountNo ? "missing_account_no" : "missing_customer_name", !accountNo ? "Account No is blank or not a number" : "Customer Name is blank");
      continue;
    }

    if (lines.has(phone.e164)) {
      stats.conflicting_rows++;
      flag(row, "conflicting_duplicate", `${phone.e164} already appears in row ${lines.get(phone.e164)!.row_number} with different values; the first row was kept`);
      continue;
    }

    const end = parseDate(c["Contract End Date"]);
    if (!end.ok) flag(row, end.reason, `Contract End Date ${end.detail}; the line was imported without changing its end date`);

    const regNo = text(c["Reg No"]);
    const existing = accounts.get(accountNo);
    if (!existing) {
      accounts.set(accountNo, {
        account_no: accountNo,
        reg_no: regNo,
        legal_name: name,
        normalised_name: normaliseCompanyName(name),
        segment: text(c["Segment"]),
        dealer_code: text(c["dealer_code"]),
      });
    } else if (!existing.reg_no && regNo) {
      existing.reg_no = regNo;
    }

    const contractEnd = end.ok ? end.date : null;
    const exportStatus = text(c["Contract Status"]);
    if (exportStatus === "InContract" && contractEnd && contractEnd < today) stats.stale_export_status_rows++;
    if (phone.type === "landline") stats.landlines++;
    lines.set(phone.e164, {
      row_number: row.rowNumber,
      account_no: accountNo,
      msisdn_e164: phone.e164,
      number_type: phone.type,
      priceplan: text(c["Priceplan"]),
      priceplan_name: text(c["Priceplan Name"]),
      term_months: integer(c["Contract Term"]),
      contract_end_date: contractEnd,
      end_date_trusted: end.ok,
      device: device(c["Device Type"], c["Device Model"]),
      monthly_charge_zar: money(c["chg_subs"]),
      export_status: exportStatus,
    });
  }
  stats.quarantined_rows = flagged.size;
  return { accounts: [...accounts.values()], lines: [...lines.values()], seen: [...seen], quarantine, stats };
}

/** Reads, checks and applies a base export. Throws ImportStructureError / ImportApplyError. */
export async function importBaseFile(db: Db, fileName: string, buffer: ArrayBuffer | Buffer): Promise<ImportResult> {
  const plan = planBaseImport(baseSheet(await readWorkbook(buffer)));
  const { data, error } = await db.rpc("import_base", {
    p_file_name: fileName,
    p_file_sha256: await sha256Hex(buffer),
    p_accounts: plan.accounts,
    p_lines: plan.lines.map((l) => ({
      account_no: l.account_no,
      msisdn_e164: l.msisdn_e164,
      number_type: l.number_type,
      priceplan: l.priceplan,
      priceplan_name: l.priceplan_name,
      term_months: l.term_months,
      contract_end_date: l.contract_end_date,
      end_date_trusted: l.end_date_trusted,
      device: l.device,
      monthly_charge_zar: l.monthly_charge_zar,
    })),
    p_seen_msisdns: plan.seen,
    p_quarantine: plan.quarantine,
    p_file_stats: plan.stats,
  });
  if (error) throw new ImportApplyError(error.message, error.code);
  const result = data as { run_id: string; counts: Record<string, unknown> };
  return { runId: result.run_id, kind: "base", fileName, counts: result.counts, quarantine: plan.quarantine };
}
