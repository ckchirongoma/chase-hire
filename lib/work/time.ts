/** Postgres interval text (as PostgREST returns it) → milliseconds. */

const UNIT_MS: Record<string, number> = {
  year: 365 * 86_400_000,
  mon: 30 * 86_400_000,
  week: 7 * 86_400_000,
  day: 86_400_000,
  hour: 3_600_000,
  min: 60_000,
  sec: 1000,
};

/**
 * Parses "04:00:00", "48:00:00", "7 days", "1 day 02:30:00", "3 hours" or ISO "PT4H" style text.
 * Returns null for anything it does not recognise.
 */
export function intervalToMs(input: string | null | undefined): number | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  const iso = s.match(/^p(?:(\d+)d)?(?:t(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?)?$/);
  if (iso && s !== "p") {
    const [, d, h, m, sec] = iso;
    return (Number(d ?? 0) * 24 * 3600 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(sec ?? 0)) * 1000;
  }
  let total = 0;
  let matched = false;
  let rest = s.replace(/(-?\d+(?:\.\d+)?)\s*(years?|mons?|months?|weeks?|days?|hours?|mins?|minutes?|secs?|seconds?)\b/g, (_m, n: string, unit: string) => {
    const key = Object.keys(UNIT_MS).find((k) => unit.startsWith(k)) ?? (unit.startsWith("month") ? "mon" : null);
    if (!key) return _m;
    total += Number(n) * UNIT_MS[key];
    matched = true;
    return " ";
  });
  rest = rest.replace(/(-)?(\d+):(\d{2})(?::(\d{2}(?:\.\d+)?))?/, (_m, neg: string | undefined, h: string, m: string, sec: string | undefined) => {
    const ms = (Number(h) * 3600 + Number(m) * 60 + Number(sec ?? 0)) * 1000;
    total += neg ? -ms : ms;
    matched = true;
    return " ";
  });
  if (!matched || rest.trim()) return null;
  return total;
}

/** "4 hours", "48 hours", "7 days", "25 minutes". */
export function humanDuration(ms: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (ms % 86_400_000 === 0 && ms >= 7 * 86_400_000) return plural(ms / 86_400_000, "day");
  if (ms % 3_600_000 === 0) return plural(ms / 3_600_000, "hour");
  if (ms % 60_000 === 0) return plural(ms / 60_000, "minute");
  return plural(Math.round(ms / 1000), "second");
}

/** Countdown text: "3:59:12" or "12:05" (display only; the server enforces every deadline). */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h ${mm}m`;
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
