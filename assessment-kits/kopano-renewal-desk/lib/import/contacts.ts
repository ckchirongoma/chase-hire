import { ImportStructureError } from "./columns";
import { idText, normaliseCompanyName, normalisePhone, rawValue, text } from "./normalise";
import { ImportApplyError, sha256Hex, type Db, type ImportResult, type QuarantineRow } from "./types";
import { readWorkbook, type Sheet } from "./xlsx";

/**
 * Agents' personal contact sheets (one tab per agent, each laid out differently) merged into
 * shared contact points. Business rule BR-C2 in the handoff pack: numbers and emails captured by
 * agents for existing customers start as `existing_customer_s69_3` (utility messages only);
 * marketing needs an explicit opt-in recorded on a call.
 */

export const CONTACT_SHEET_CONSENT = "existing_customer_s69_3" as const;

const SYNONYMS = {
  account: ["account no", "acc #", "account", "account number"],
  company: ["company", "customer", "company name", "customer name"],
  person: ["contact person", "name", "decision maker", "contact"],
  phone: ["cell", "mobile", "number", "cellphone", "phone"],
  landline: ["landline", "tel", "telephone"],
  email: ["email", "e-mail", "email address"],
} as const;

type Field = keyof typeof SYNONYMS;

export interface PlannedContact {
  row_number: number;
  sheet: string;
  account_no: string | null;
  normalised_name: string;
  type: "mobile" | "landline" | "email";
  value: string;
  person_name: string | null;
  role: "decision_maker" | "admin" | "unknown";
  consent_status: typeof CONTACT_SHEET_CONSENT;
  source: string;
  raw: QuarantineRow["raw"];
}

function columnsOf(sheet: Sheet): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  for (const h of sheet.headers) {
    const k = h.trim().toLowerCase();
    for (const [field, names] of Object.entries(SYNONYMS) as [Field, readonly string[]][]) {
      if (!out[field] && names.includes(k)) out[field] = h;
    }
  }
  return out;
}

function personAndRole(value: string | null, header: string | undefined): { person: string | null; role: PlannedContact["role"] } {
  if (!value) return { person: null, role: header?.toLowerCase() === "decision maker" ? "decision_maker" : "unknown" };
  const m = value.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  const person = (m ? m[1] : value).trim() || null;
  const label = (m ? m[2] : "").toLowerCase();
  if (header?.toLowerCase() === "decision maker" || /owner|director|md|ceo|partner/.test(label)) return { person, role: "decision_maker" };
  if (/bookkeep|reception|office|admin|account/.test(label)) return { person, role: "admin" };
  return { person, role: "unknown" };
}

/** One contact point per phone number or email address found on each tab. Pure. */
export function planContactsImport(sheets: Sheet[]): { contacts: PlannedContact[]; quarantine: QuarantineRow[]; stats: Record<string, number> } {
  const contacts: PlannedContact[] = [];
  const quarantine: QuarantineRow[] = [];
  let rows = 0;
  for (const sheet of sheets) {
    const cols = columnsOf(sheet);
    if (!cols.company && !cols.account) {
      throw new ImportStructureError(`Sheet "${sheet.name}" has no company or account column (found: ${sheet.headers.filter(Boolean).join(", ")}). Nothing was imported.`, ["Company"], []);
    }
    if (!cols.phone && !cols.landline && !cols.email) {
      throw new ImportStructureError(`Sheet "${sheet.name}" has no phone or email column. Nothing was imported.`, ["Phone"], []);
    }
    for (const row of sheet.rows) {
      rows++;
      const raw = Object.fromEntries(sheet.headers.filter(Boolean).map((h) => [h, rawValue(row.cells[h])]));
      // Sheets are numbered by tab so the report can point at "Tab: row".
      const rowRef = row.rowNumber;
      const company = text(cols.company ? row.cells[cols.company] : null);
      const accountNo = cols.account ? idText(row.cells[cols.account]) : null;
      if (!company && !accountNo) {
        quarantine.push({ row_number: rowRef, reason: "unknown_customer", detail: `Sheet "${sheet.name}": no company name or account number`, raw });
        continue;
      }
      const { person, role } = personAndRole(text(cols.person ? row.cells[cols.person] : null), cols.person);
      const base = {
        row_number: rowRef,
        sheet: sheet.name,
        account_no: accountNo,
        normalised_name: normaliseCompanyName(company ?? ""),
        person_name: person,
        role,
        consent_status: CONTACT_SHEET_CONSENT,
        source: `agent_sheet:${sheet.name}`,
        raw,
      };
      for (const field of ["phone", "landline"] as const) {
        const col = cols[field];
        const cell = col ? row.cells[col] : null;
        if (cell === null || cell === undefined || cell === "") continue;
        const phone = normalisePhone(cell);
        if (!phone.ok) {
          quarantine.push({ row_number: rowRef, reason: "invalid_phone", detail: `Sheet "${sheet.name}", ${col}: ${phone.reason}`, raw });
          continue;
        }
        contacts.push({ ...base, type: phone.type, value: phone.e164 });
      }
      const email = text(cols.email ? row.cells[cols.email] : null)?.toLowerCase() ?? null;
      if (email) {
        if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) contacts.push({ ...base, type: "email", value: email });
        else quarantine.push({ row_number: rowRef, reason: "invalid_email", detail: `Sheet "${sheet.name}": "${email}" is not an email address`, raw });
      }
    }
  }
  return { contacts, quarantine, stats: { sheets: sheets.length, sheet_rows: rows, contact_values: contacts.length } };
}

export async function importContactsFile(db: Db, fileName: string, buffer: ArrayBuffer | Buffer): Promise<ImportResult> {
  const plan = planContactsImport(await readWorkbook(buffer));
  const { data, error } = await db.rpc("import_contacts", {
    p_file_name: fileName,
    p_file_sha256: await sha256Hex(buffer),
    p_rows: plan.contacts,
    p_quarantine: plan.quarantine,
  });
  if (error) throw new ImportApplyError(error.message, error.code);
  const result = data as { run_id: string; counts: Record<string, unknown> };
  return { runId: result.run_id, kind: "contacts", fileName, counts: { ...plan.stats, ...result.counts }, quarantine: plan.quarantine };
}
