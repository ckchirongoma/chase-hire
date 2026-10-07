// Answer-time signals for the role quiz (doc 01 §4). Signals are context for a human
// reviewer only: never evidence on their own, never grounds for rejection.

/** A correct single-answer item faster than this is hard to explain by reading alone. */
export const FAST_SINGLE_MS = 3000;
/** "Select all" items need more reading, so the bar is higher. */
export const FAST_MULTI_MS = 4000;
/** A long stall on one item followed by a correct answer (possible look-up). */
export const STALL_MS = 120_000;

export type AnswerTimeFlag = "fast_correct" | "stall_then_correct" | null;

export function answerTimeFlag(x: { multi: boolean; correct: boolean; ms: number }): AnswerTimeFlag {
  if (!x.correct || !Number.isFinite(x.ms) || x.ms < 0) return null;
  if (x.ms < (x.multi ? FAST_MULTI_MS : FAST_SINGLE_MS)) return "fast_correct";
  if (x.ms > STALL_MS) return "stall_then_correct";
  return null;
}
