import { QUIZ_GRACE_MS } from "./blueprint";

// Display-only clock for the quiz runner. The server owns the deadline: it accepts answers
// until QUIZ_GRACE_MS after it, and only then treats the attempt as expired and finalises
// it. So the runner asks the server for the result once the grace period (plus a little
// slack for clock offset) has passed, and asks again every few seconds while the server
// still reports the attempt as active.

/** Slack after the grace period before the first expiry check. */
export const EXPIRY_CHECK_SLACK_MS = 1000;
/** Gap between expiry checks while the server still says "active". */
export const EXPIRY_RECHECK_MS = 5000;

export type QuizClock = {
  /** Time left on the display, never below 0. */
  remainingMs: number;
  /** False once the grace period has passed: the server will refuse answers. */
  acceptsAnswers: boolean;
  /** True when the runner should ask the server for the (finalised) state now. */
  expiryCheckDue: boolean;
};

/**
 * @param deadlineMs   the attempt's deadline (server clock)
 * @param nowMs        the current time on the server clock (client clock + measured offset)
 * @param lastCheckMs  when the last expiry check was sent (server clock), or null
 */
export function quizClock(deadlineMs: number, nowMs: number, lastCheckMs: number | null): QuizClock {
  const left = deadlineMs - nowMs;
  const pastGrace = left < -QUIZ_GRACE_MS;
  const checkWindow = left <= -(QUIZ_GRACE_MS + EXPIRY_CHECK_SLACK_MS);
  return {
    remainingMs: Math.max(0, left),
    acceptsAnswers: !pastGrace,
    expiryCheckDue: checkWindow && (lastCheckMs === null || nowMs - lastCheckMs >= EXPIRY_RECHECK_MS),
  };
}
