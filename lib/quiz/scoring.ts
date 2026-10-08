// Role quiz scoring. The DB marks each response (quiz_response_guard); these helpers
// mirror that rule and aggregate the marked rows into the attempt result.

export type TopicScores = Record<string, { correct: number; total: number }>;

/** Sorted, de-duplicated answer indexes; an empty or missing answer is a skip (null). */
export function normaliseAnswer(answer: readonly number[] | null | undefined): number[] | null {
  if (!answer || answer.length === 0) return null;
  return [...new Set(answer)].sort((a, b) => a - b);
}

/** All-or-nothing: the chosen set must equal the key set exactly. A skip is wrong. */
export function isCorrect(answer: readonly number[] | null | undefined, key: readonly number[]): boolean {
  const a = normaliseAnswer(answer);
  const k = normaliseAnswer(key);
  if (!a || !k || a.length !== k.length) return false;
  return a.every((x, i) => x === k[i]);
}

/** Percentage correct, rounded to one decimal place. */
export function quizPct(correct: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((correct / total) * 1000) / 10;
}

/** Below the role's quiz flag line (doc 03: e.g. BA < 50%, SWE < 55%). Exact, not rounded. */
export function isBelowFlag(correct: number, total: number, flagPct: number): boolean {
  if (total <= 0) return true;
  return correct * 100 < flagPct * total;
}

/** {topic: {correct, total}}; topics in `topicOrder` are always present, even with no rows. */
export function topicBreakdown(
  rows: readonly { topic: string; correct: boolean | null }[],
  topicOrder: readonly string[] = [],
): TopicScores {
  const out: TopicScores = {};
  for (const t of topicOrder) out[t] = { correct: 0, total: 0 };
  for (const r of rows) {
    const slot = (out[r.topic] ??= { correct: 0, total: 0 });
    slot.total += 1;
    if (r.correct === true) slot.correct += 1;
  }
  return out;
}

export type QuizScore = { rawScore: number; total: number; pct: number; topicScores: TopicScores; belowFlag: boolean };

export function scoreQuiz(
  rows: readonly { topic: string; correct: boolean | null }[],
  flagPct: number,
  topicOrder: readonly string[] = [],
): QuizScore {
  const rawScore = rows.filter((r) => r.correct === true).length;
  const total = rows.length;
  return {
    rawScore,
    total,
    pct: quizPct(rawScore, total),
    topicScores: topicBreakdown(rows, topicOrder),
    belowFlag: isBelowFlag(rawScore, total, flagPct),
  };
}
