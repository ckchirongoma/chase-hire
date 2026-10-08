/**
 * Retention date rules (docs/12 §1, the notice in lib/consent/notice.ts). The database computes
 * the schedule (public.retention_schedule, migration 20261007000018); this mirrors its date
 * arithmetic so the rules are unit-tested, and the integration test checks the two agree.
 *
 * - Not appointed: purge 6 months after the application closed (or after the last activity of
 *   someone who never applied).
 * - Talent-pool opt-in on the latest consent: 12 months instead.
 * - Month arithmetic is calendar months in UTC, clamped to the month's last day like Postgres
 *   (31 Aug + 6 months = 28/29 Feb).
 */

export const RETENTION_MONTHS = { standard: 6, talentPool: 12 } as const;

export function retentionMonths(talentPool: boolean): number {
  return talentPool ? RETENTION_MONTHS.talentPool : RETENTION_MONTHS.standard;
}

const pad = (n: number) => String(n).padStart(2, "0");

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** Adds calendar months to a UTC date, clamping the day; returns YYYY-MM-DD. */
export function addMonthsUtc(at: Date | string, months: number): string {
  const d = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) throw new RangeError("addMonthsUtc: invalid date");
  if (!Number.isInteger(months)) throw new RangeError("addMonthsUtc: months must be an integer");
  const total = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(total / 12);
  const month0 = ((total % 12) + 12) % 12;
  const day = Math.min(d.getUTCDate(), daysInMonth(year, month0));
  return `${year}-${pad(month0 + 1)}-${pad(day)}`;
}

/** The purge date for a person whose clock started at `basisAt`. */
export function purgeAfter(basisAt: Date | string, talentPool: boolean): string {
  return addMonthsUtc(basisAt, retentionMonths(talentPool));
}

/** Today's date in UTC (YYYY-MM-DD), the calendar the schedule uses. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** A purge is due once its date has arrived. */
export function isDue(purgeAfterDate: string, now: Date = new Date()): boolean {
  return purgeAfterDate <= utcDay(now);
}

export type RetentionFacts = {
  admin: boolean;
  /** Any application still in play (not rejected, withdrawn, lapsed or closed). */
  openApplication: boolean;
  /** Advanced out of the offer stage: an employee record, outside this purge. */
  appointed: boolean;
  openReviewRequest: boolean;
  /** When the latest closed application closed; null if they never applied. */
  closedAt: Date | string | null;
  /** The latest of sign-up, consent, CV upload, reasoning attempt, application and review request. */
  lastActivity: Date | string;
  /** talent_pool_opt_in on the latest consents row. */
  talentPool: boolean;
};

/** The schedule for one person, or null when they are never queued. */
export function retentionEntry(f: RetentionFacts): { purgeAfter: string; basisAt: string; basis: "application_closed" | "no_application" } | null {
  if (f.admin || f.openApplication || f.appointed || f.openReviewRequest) return null;
  const last = new Date(f.lastActivity);
  const closed = f.closedAt === null ? null : new Date(f.closedAt);
  const basisAt = closed && closed > last ? closed : last;
  return {
    purgeAfter: purgeAfter(basisAt, f.talentPool),
    basisAt: basisAt.toISOString(),
    basis: closed ? "application_closed" : "no_application",
  };
}
