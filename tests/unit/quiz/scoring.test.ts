import { describe, expect, it } from "vitest";
import { isBelowFlag, isCorrect, normaliseAnswer, quizPct, scoreQuiz, topicBreakdown } from "@/lib/quiz/scoring";
import { answerTimeFlag } from "@/lib/quiz/signals";

describe("normaliseAnswer", () => {
  it("sorts and de-duplicates; empty or missing is a skip", () => {
    expect(normaliseAnswer([3, 1, 3])).toEqual([1, 3]);
    expect(normaliseAnswer([])).toBeNull();
    expect(normaliseAnswer(null)).toBeNull();
    expect(normaliseAnswer(undefined)).toBeNull();
  });
});

describe("isCorrect (all-or-nothing)", () => {
  it("single answer", () => {
    expect(isCorrect([2], [2])).toBe(true);
    expect(isCorrect([1], [2])).toBe(false);
    expect(isCorrect(null, [2])).toBe(false);
    expect(isCorrect([], [2])).toBe(false);
  });

  it("select all that apply needs exactly the key set", () => {
    expect(isCorrect([0, 2, 3], [0, 2, 3])).toBe(true);
    expect(isCorrect([3, 0, 2], [0, 2, 3])).toBe(true); // order doesn't matter
    expect(isCorrect([0, 2, 2, 3], [0, 2, 3])).toBe(true); // duplicates collapse
    expect(isCorrect([0, 2], [0, 2, 3])).toBe(false); // missing one
    expect(isCorrect([0, 1, 2, 3], [0, 2, 3])).toBe(false); // one extra
    expect(isCorrect([1], [0, 2, 3])).toBe(false);
  });
});

describe("quizPct", () => {
  it("rounds to one decimal place", () => {
    expect(quizPct(9, 15)).toBe(60);
    expect(quizPct(8, 15)).toBe(53.3);
    expect(quizPct(7, 15)).toBe(46.7);
    expect(quizPct(15, 15)).toBe(100);
    expect(quizPct(0, 15)).toBe(0);
    expect(quizPct(0, 0)).toBe(0);
  });
});

describe("isBelowFlag", () => {
  it("BA flag line 50%: 7/15 is below, 8/15 is not", () => {
    expect(isBelowFlag(7, 15, 50)).toBe(true);
    expect(isBelowFlag(8, 15, 50)).toBe(false);
  });

  it("SWE flag line 55%: 8/15 is below, 9/15 is not", () => {
    expect(isBelowFlag(8, 15, 55)).toBe(true);
    expect(isBelowFlag(9, 15, 55)).toBe(false);
  });

  it("exactly on the line is not below (strictly less than)", () => {
    expect(isBelowFlag(9, 15, 60)).toBe(false); // 60.0%
    expect(isBelowFlag(6, 15, 40)).toBe(false); // 40.0%
    expect(isBelowFlag(5, 10, 50)).toBe(false);
    expect(isBelowFlag(4, 10, 50)).toBe(true);
  });

  it("an empty attempt is always flagged", () => {
    expect(isBelowFlag(0, 0, 0)).toBe(true);
  });
});

describe("topicBreakdown", () => {
  it("counts correct and total per topic, treating null as not correct", () => {
    const rows = [
      { topic: "a", correct: true },
      { topic: "a", correct: false },
      { topic: "b", correct: null },
      { topic: "a", correct: true },
    ];
    expect(topicBreakdown(rows)).toEqual({ a: { correct: 2, total: 3 }, b: { correct: 0, total: 1 } });
  });

  it("includes every topic in the order list even with no rows", () => {
    expect(topicBreakdown([{ topic: "a", correct: true }], ["a", "z"])).toEqual({
      a: { correct: 1, total: 1 },
      z: { correct: 0, total: 0 },
    });
  });
});

describe("scoreQuiz", () => {
  it("aggregates a 15-item attempt", () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ topic: i < 5 ? "x" : "y", correct: i % 3 === 0 }));
    const s = scoreQuiz(rows, 55, ["x", "y"]);
    expect(s.rawScore).toBe(5);
    expect(s.total).toBe(15);
    expect(s.pct).toBe(33.3);
    expect(s.belowFlag).toBe(true);
    expect(s.topicScores).toEqual({ x: { correct: 2, total: 5 }, y: { correct: 3, total: 10 } });
  });
});

describe("answerTimeFlag (signal only)", () => {
  it("flags implausibly fast correct answers and long stalls before a correct answer", () => {
    expect(answerTimeFlag({ multi: false, correct: true, ms: 2000 })).toBe("fast_correct");
    expect(answerTimeFlag({ multi: false, correct: true, ms: 3500 })).toBeNull();
    expect(answerTimeFlag({ multi: true, correct: true, ms: 3500 })).toBe("fast_correct");
    expect(answerTimeFlag({ multi: false, correct: true, ms: 130_000 })).toBe("stall_then_correct");
  });

  it("never flags wrong answers or bad timings", () => {
    expect(answerTimeFlag({ multi: false, correct: false, ms: 500 })).toBeNull();
    expect(answerTimeFlag({ multi: false, correct: true, ms: -1 })).toBeNull();
    expect(answerTimeFlag({ multi: false, correct: true, ms: Number.NaN })).toBeNull();
  });
});
