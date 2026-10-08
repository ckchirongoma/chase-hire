/** UTC date helpers for the generators (Excel cells are written from UTC dates). */

export const EXPORT_DATE = "2026-10-07";

export function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

export function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return utc(y, m, d);
}

export function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/** Adds calendar months, clamping the day to the target month's length. */
export function addMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const target = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), last)));
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Weekdays (Mon–Fri) of a month. */
export function weekdaysOf(year: number, month: number): Date[] {
  const out: Date[] = [];
  for (let d = utc(year, month, 1); d.getUTCMonth() === month - 1; d = addDays(d, 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d);
  }
  return out;
}

/** Normalises a cell value read back by exceljs to a UTC midnight Date, or null. */
export function asDate(v: unknown): Date | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  return null;
}
