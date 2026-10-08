/**
 * Cell-level normalisation shared by every import. Pure functions: no I/O, easy to test.
 */

export type Cell = string | number | boolean | Date | null;

export type NumberType = "mobile" | "landline";
export type PhoneResult = { ok: true; e164: string; type: NumberType } | { ok: false; reason: string };

/**
 * Normalises a phone cell to E.164 text (+27XXXXXXXXX) and says whether it is a mobile or a
 * landline. Exports store numbers as numbers (the leading zero is lost), as 27XXXXXXXXX, or as
 * text with spaces, brackets, dots or dashes; all of those resolve to the same E.164 value.
 */
export function normalisePhone(value: Cell | undefined): PhoneResult {
  if (value === null || value === undefined || value === "" || value === 0 || value === "0") return { ok: false, reason: "missing" };
  if (typeof value === "boolean" || value instanceof Date) return { ok: false, reason: "not a phone number" };
  let digits = (typeof value === "number" ? String(Math.trunc(value)) : value).trim().replace(/[\s().\-/]/g, "");
  if (digits.startsWith("+27")) digits = `0${digits.slice(3)}`;
  else if (digits.startsWith("+")) return { ok: false, reason: "not a South African number" };
  else if (/^27\d{9}$/.test(digits)) digits = `0${digits.slice(2)}`;
  else if (/^\d{9}$/.test(digits)) digits = `0${digits}`;
  if (!/^0\d{9}$/.test(digits)) return { ok: false, reason: `"${String(value)}" is not a 10-digit number` };
  if (/^0[6-8]/.test(digits)) return { ok: true, e164: `+27${digits.slice(1)}`, type: "mobile" };
  if (/^0[1-5]/.test(digits)) return { ok: true, e164: `+27${digits.slice(1)}`, type: "landline" };
  return { ok: false, reason: `"${String(value)}" is not a valid South African number` };
}

export type DateResult = { ok: true; date: string | null } | { ok: false; reason: "ambiguous_date" | "invalid_date" | "epoch_date"; detail: string };

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function checked(y: number, m: number, d: number, raw: string): DateResult {
  if (!validYmd(y, m, d)) return { ok: false, reason: "invalid_date", detail: `"${raw}" is not a real date` };
  if (y <= 1970) return { ok: false, reason: "epoch_date", detail: `"${raw}" is a placeholder (1970), not a contract end date` };
  if (y > 2100) return { ok: false, reason: "invalid_date", detail: `"${raw}" is too far in the future` };
  return { ok: true, date: isoOf(y, m, d) };
}

/**
 * Parses a date cell to YYYY-MM-DD. Real Excel dates and ISO text are trusted. Slash dates are
 * read day-first or month-first only when one part is over 12; when both parts are 12 or less
 * (05/11/2027) the date cannot be known, so it is reported as ambiguous instead of guessed.
 * 1970-01-01 placeholders are reported as epoch dates. A blank cell is a null date.
 */
export function parseDate(value: Cell | undefined): DateResult {
  if (value === null || value === undefined || value === "") return { ok: true, date: null };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { ok: false, reason: "invalid_date", detail: "unreadable date cell" };
    return checked(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate(), value.toISOString().slice(0, 10));
  }
  if (typeof value === "number") {
    // Excel serial day number (1900 date system).
    if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: "epoch_date", detail: `${value} is not a date` };
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000);
    return checked(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), String(value));
  }
  if (typeof value === "boolean") return { ok: false, reason: "invalid_date", detail: "not a date" };
  const raw = value.trim();
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) return checked(Number(m[1]), Number(m[2]), Number(m[3]), raw);
  m = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const [y, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (b > 12 && c <= 12) return checked(y, c, b, raw); // YYYY/DD/MM
    if (b <= 12 && c > 12) return checked(y, b, c, raw);
    if (b !== c && b <= 12 && c <= 12) return { ok: false, reason: "ambiguous_date", detail: `"${raw}" could be ${isoOf(y, b, c)} or ${isoOf(y, c, b)}` };
    return checked(y, b, c, raw);
  }
  m = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (a > 12 && b <= 12) return checked(y, b, a, raw); // day first
    if (b > 12 && a <= 12) return checked(y, a, b, raw); // month first (US export)
    if (a === b) return checked(y, a, b, raw);
    if (a <= 12 && b <= 12) return { ok: false, reason: "ambiguous_date", detail: `"${raw}" could be ${isoOf(y, b, a)} or ${isoOf(y, a, b)}` };
    return { ok: false, reason: "invalid_date", detail: `"${raw}" is not a real date` };
  }
  return { ok: false, reason: "invalid_date", detail: `"${raw}" is not a date` };
}

/** Contract status from the end date (the export's own status column goes stale). */
export function deriveContractStatus(endDate: string | null, today: string = new Date().toISOString().slice(0, 10)): "InContract" | "Out Of Contract" | "Unknown" {
  if (!endDate) return "Unknown";
  return endDate >= today ? "InContract" : "Out Of Contract";
}

/**
 * Company identity key: upper case, legal suffixes ((PTY) LTD, PTY LTD, CC) and punctuation
 * removed, "&" spelled "AND", single spaces. "Mokoena Logistics (Pty) Ltd." and
 * "MOKOENA  LOGISTICS (PTY)LTD" give the same key.
 */
export function normaliseCompanyName(name: string): string {
  return name
    .toUpperCase()
    .replace(/\(\s*PTY\s*\)\s*LTD\.?/g, " ")
    .replace(/\bPTY\s*LTD\.?\b/g, " ")
    .replace(/\bPROPRIETARY\s+LIMITED\b/g, " ")
    .replace(/\bC\.?C\.?$/g, " ")
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Trimmed text, or null for a blank cell. */
export function text(value: Cell | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

/** An identifier such as an account number: digits kept as text, never as a float. */
export function idText(value: Cell | undefined): string | null {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : null;
  const s = text(value);
  return s && /^[A-Za-z0-9/-]+$/.test(s) ? s : null;
}

/** Rands: a number, or null when blank or unreadable. */
export function money(value: Cell | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[R\s,]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function integer(value: Cell | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isInteger(n) ? n : null;
}

/** A value safe to keep in the quarantine report (dates as ISO text). */
export function rawValue(value: Cell | undefined): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}
