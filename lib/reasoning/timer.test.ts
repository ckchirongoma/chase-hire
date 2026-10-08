import { describe, expect, it } from 'vitest';
import { deadlineFrom, GRACE_MS, isLate, REASONING_DURATION_MS, remainingMs } from './timer';
import { isSuspiciouslyFast } from './signals';

const start = new Date('2026-10-07T10:00:00.000Z');
const deadline = deadlineFrom(start);
const plus = (ms: number) => new Date(deadline.getTime() + ms);

describe('timer', () => {
  it('gives 15 minutes', () => {
    expect(REASONING_DURATION_MS).toBe(900_000);
    expect(deadline.toISOString()).toBe('2026-10-07T10:15:00.000Z');
  });

  it('is not late at the deadline or within the grace window', () => {
    expect(isLate(plus(-1), deadline)).toBe(false);
    expect(isLate(deadline, deadline)).toBe(false);
    expect(isLate(plus(GRACE_MS), deadline)).toBe(false);
  });

  it('is late 1 ms after deadline + grace', () => {
    expect(isLate(plus(GRACE_MS + 1), deadline)).toBe(true);
    expect(isLate(plus(1), deadline, 0)).toBe(true);
  });

  it('remainingMs counts down and never goes negative', () => {
    expect(remainingMs(start, deadline)).toBe(REASONING_DURATION_MS);
    expect(remainingMs(plus(-1000), deadline)).toBe(1000);
    expect(remainingMs(deadline, deadline)).toBe(0);
    expect(remainingMs(plus(60_000), deadline)).toBe(0);
  });
});

describe('isSuspiciouslyFast', () => {
  it('flags only correct hard answers under 4 s', () => {
    expect(isSuspiciouslyFast({ tier: 'hard', correct: true, ms: 3999 })).toBe(true);
    expect(isSuspiciouslyFast({ tier: 'hard', correct: true, ms: 4000 })).toBe(false);
    expect(isSuspiciouslyFast({ tier: 'hard', correct: false, ms: 1000 })).toBe(false);
    expect(isSuspiciouslyFast({ tier: 'medium', correct: true, ms: 1000 })).toBe(false);
  });
});
