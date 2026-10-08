/**
 * Retention date rules (docs/12 §1, the notice in lib/consent/notice.ts). The database computes
 * the schedule (public.retention_schedule, migration 20261007000018); this mirrors its rules so
 * they are unit-tested, and the integration test checks the two agree.
 *
 * - A person is queued only once every application of theirs is closed (rejected, withdrawn,
 *   lapsed or at stage closed). One application still in play keeps them off the queue, however
 *   long it has been idle and whether or not its role is still active: only an admin closes an
 *   application, with a written reason (an idle one with a "lapse" decision).
 * - Each closed application's clock starts when it closed, or when its role's hiring round
 *   closed if that was later.
 * - Not appointed: purge 6 months after the latest of those and the person's own last activity
 *   (or after the last activity of someone who never applied).
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

/** Adds calendar months to a UTC timestamp, clamping the day and keeping the time of day. */
export function addMonthsUtcTs(at: Date | string, months: number): Date {
  const d = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) throw new RangeError("addMonthsUtc: invalid date");
  if (!Number.isInteger(months)) throw new RangeError("addMonthsUtc: months must be an integer");
  const total = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(total / 12);
  const month0 = ((total % 12) + 12) % 12;
  const day = Math.min(d.getUTCDate(), daysInMonth(year, month0));
  return new Date(Date.UTC(year, month0, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

/** Adds calendar months to a UTC date, clamping the day; returns YYYY-MM-DD. */
export function addMonthsUtc(at: Date | string, months: number): string {
  const d = addMonthsUtcTs(at, months);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
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

export type RetentionBasis = "application_closed" | "round_closed" | "no_application";

export type ApplicationFacts = {
  /** Rejected, withdrawn or lapsed, or at stage closed. */
  closed: boolean;
  /** When it closed (null while open). */
  closedAt: Date | string | null;
  /** When the role's hiring round closed (the role was made inactive); null while it is open. */
  roundClosedAt: Date | string | null;
  /** The latest activity on the application (used when an old closed row has no close time). */
  activeAt: Date | string;
};

const toDate = (x: Date | string) => (typeof x === "string" ? new Date(x) : x);
const later = (a: Date, b: Date | null) => (b && b > a ? b : a);

/** When a closed application's retention clock starts; null while it is still in play (never queued). */
export function applicationEnd(a: ApplicationFacts): { at: Date; basis: Exclude<RetentionBasis, "no_application"> } | null {
  if (!a.closed) return null;
  const round = a.roundClosedAt === null ? null : toDate(a.roundClosedAt);
  const closed = a.closedAt === null ? toDate(a.activeAt) : toDate(a.closedAt);
  return round && round > closed ? { at: round, basis: "round_closed" } : { at: closed, basis: "application_closed" };
}

export type RetentionFacts = {
  admin: boolean;
  /** Named as staff on a decision, scorecard, review response etc. (never purged by this job). */
  formerStaff?: boolean;
  /** Advanced out of the offer stage: an employee record, outside this purge. */
  appointed: boolean;
  openReviewRequest: boolean;
  applications: ApplicationFacts[];
  /** The latest of sign-up, consent, CV upload, reasoning attempt, application and review request. */
  lastActivity: Date | string;
  /** talent_pool_opt_in on the latest consents row. */
  talentPool: boolean;
};

/** The schedule for one person, or null when they are never queued (or not yet: in play). */
export function retentionEntry(f: RetentionFacts): { purgeAfter: string; basisAt: string; basis: RetentionBasis } | null {
  if (f.admin || f.formerStaff || f.appointed || f.openReviewRequest) return null;
  let end: { at: Date; basis: RetentionBasis } | null = null;
  for (const a of f.applications) {
    const e = applicationEnd(a);
    if (!e) return null; // still in play
    if (!end || e.at > end.at) end = e;
  }
  const last = toDate(f.lastActivity);
  const basisAt = end ? later(last, end.at) : last;
  return {
    purgeAfter: purgeAfter(basisAt, f.talentPool),
    basisAt: basisAt.toISOString(),
    basis: end ? end.basis : "no_application",
  };
}

/**
 * The order a purge run works through people. Runs are bounded by time (the deadline), so the
 * order matters: purges that stopped halfway (fewest failed attempts first) alternate with the
 * people newly due, so unfinished ones can never take more than about half of a run while
 * others wait, and every run makes progress on both; whatever one side doesn't need goes to the
 * other. `limit` caps the list (a safety bound; the deadline normally ends a run first).
 */
export function purgeBatch(
  resuming: readonly { userId: string; attempts: number; startedAt: string }[],
  due: readonly string[],
  limit: number,
): string[] {
  const n = Math.max(0, Math.floor(limit));
  const stuck = [...resuming].sort((a, b) => a.attempts - b.attempts || a.startedAt.localeCompare(b.startedAt)).map((r) => r.userId);
  const resumingIds = new Set(stuck);
  const fresh = [...new Set(due)].filter((id) => !resumingIds.has(id));
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (out.length < n && (i < stuck.length || j < fresh.length)) {
    if (i < stuck.length) out.push(stuck[i++]);
    if (out.length < n && j < fresh.length) out.push(fresh[j++]);
  }
  return out;
}
