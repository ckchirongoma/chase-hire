// Server-side timing for the Reasoning Assessment. The client countdown is display only.

export const REASONING_DURATION_MS = 15 * 60 * 1000;
/** Allowance for network latency on the final submission. */
export const GRACE_MS = 5000;

export function deadlineFrom(startedAt: Date): Date {
  return new Date(startedAt.getTime() + REASONING_DURATION_MS);
}

/** Late only once `now` is strictly past deadline + grace. */
export function isLate(now: Date, deadline: Date, graceMs: number = GRACE_MS): boolean {
  return now.getTime() > deadline.getTime() + graceMs;
}

/** Milliseconds left before the deadline (never negative; grace is not shown). */
export function remainingMs(now: Date, deadline: Date): number {
  return Math.max(0, deadline.getTime() - now.getTime());
}
