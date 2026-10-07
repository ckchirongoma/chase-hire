import { describe, expect, it } from "vitest";
import { EXPIRY_CHECK_SLACK_MS, EXPIRY_RECHECK_MS, quizClock } from "@/lib/quiz/clock";
import { QUIZ_GRACE_MS } from "@/lib/quiz/blueprint";

const DEADLINE = 1_000_000;

describe("quiz runner clock (display only)", () => {
  it("counts down and never shows less than zero", () => {
    expect(quizClock(DEADLINE, DEADLINE - 90_000, null)).toEqual({ remainingMs: 90_000, acceptsAnswers: true, expiryCheckDue: false });
    expect(quizClock(DEADLINE, DEADLINE + 2_000, null).remainingMs).toBe(0);
  });

  it("keeps accepting answers through the server's grace period, then stops", () => {
    expect(quizClock(DEADLINE, DEADLINE, null).acceptsAnswers).toBe(true);
    expect(quizClock(DEADLINE, DEADLINE + QUIZ_GRACE_MS, null).acceptsAnswers).toBe(true);
    expect(quizClock(DEADLINE, DEADLINE + QUIZ_GRACE_MS + 1, null).acceptsAnswers).toBe(false);
  });

  it("asks the server only once the server would treat the attempt as expired", () => {
    // At 0:00 the server still says "active" (it waits out the grace period), so don't ask yet.
    expect(quizClock(DEADLINE, DEADLINE, null).expiryCheckDue).toBe(false);
    expect(quizClock(DEADLINE, DEADLINE + QUIZ_GRACE_MS + 1, null).expiryCheckDue).toBe(false);
    const first = DEADLINE + QUIZ_GRACE_MS + EXPIRY_CHECK_SLACK_MS;
    expect(quizClock(DEADLINE, first, null).expiryCheckDue).toBe(true);
  });

  it("asks again every few seconds while the server still reports the attempt active", () => {
    const first = DEADLINE + QUIZ_GRACE_MS + EXPIRY_CHECK_SLACK_MS;
    expect(quizClock(DEADLINE, first + 1_000, first).expiryCheckDue).toBe(false);
    expect(quizClock(DEADLINE, first + EXPIRY_RECHECK_MS - 1, first).expiryCheckDue).toBe(false);
    expect(quizClock(DEADLINE, first + EXPIRY_RECHECK_MS, first).expiryCheckDue).toBe(true);
  });
});
