// Formatting helpers shared by the generators.

/** 12450 -> "12,450" (integers only). */
export function commas(n: number): string {
  if (!Number.isInteger(n)) throw new Error(`commas: expected an integer, got ${n}`);
  const sign = n < 0 ? '-' : '';
  return sign + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 12450 -> "R12,450" */
export function rand(n: number): string {
  return n < 0 ? `-R${commas(-n)}` : `R${commas(n)}`;
}

/** Round to 1 decimal place, symmetric for negatives. */
export function round1(x: number): number {
  const r = Math.round(Math.abs(x) * 10) / 10;
  return x < 0 ? -r : r;
}

/** 12.5 -> "12.5%"; with signed=true -> "+12.5%" / "-12.5%". */
export function pct(x: number, signed = false): string {
  const r = round1(x);
  const body = `${Math.abs(r).toFixed(1)}%`;
  if (r === 0) return body;
  if (r < 0) return `-${body}`;
  return signed ? `+${body}` : body;
}

export const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'] as const;

export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Diverse South African first names (no name is a substring of another). */
export const NAMES = [
  'Thabo', 'Ayesha', 'Pieter', 'Lindiwe', 'Ravi', 'Nomsa', 'Johan', 'Zanele',
  'Sipho', 'Fatima', 'Kagiso', 'Megan', 'Lerato', 'Priya', 'Willem', 'Naledi',
  'Bongani', 'Chantal', 'Yusuf', 'Anele',
] as const;
