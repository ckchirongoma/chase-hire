import { describe, expect, it } from "vitest";
import { NewQuizItem } from "@/lib/quiz/item-schema";
import { QuizAnswerBody } from "@/lib/quiz/api-schema";
import { nextStep } from "@/components/results/next-step";
import { MyResults } from "@/components/results/schema";
import { fmtPct, fmtRubric } from "@/components/results/labels";

const base = {
  role_topic: "business-analyst:requirements",
  stem: "Which acceptance criterion is testable?",
  options: "One\nTwo\n\nThree\nFour",
  correct: "2",
};

describe("NewQuizItem (admin add-item form)", () => {
  it("parses options one per line and converts 1-based answers to 0-based", () => {
    const r = NewQuizItem.parse(base);
    expect(r).toEqual({
      role_slug: "business-analyst",
      topic: "requirements",
      stem: base.stem,
      options: ["One", "Two", "Three", "Four"],
      answer_key: [1],
      multi: false,
    });
  });

  it("accepts several answers only for select-all items", () => {
    expect(NewQuizItem.safeParse({ ...base, correct: "1, 3" }).success).toBe(false);
    expect(NewQuizItem.parse({ ...base, correct: "3,1", multi: "on" }).answer_key).toEqual([0, 2]);
  });

  it.each([
    [{ role_topic: "business-analyst:postgres_sql" }, /Unknown role or topic/],
    [{ role_topic: "nobody:requirements" }, /Unknown role or topic/],
    [{ options: "A\nB\nC" }, /4 or 5 options/],
    [{ options: "A\nB\nC\nD\nE\nF" }, /4 or 5 options/],
    [{ options: "A\nB\nb\nD" }, /different/],
    [{ options: "A\nB\nC\nAll of the above" }, /shuffled/],
    [{ options: "A\nB\nC\nBoth A and B" }, /shuffled/],
    [{ correct: "5" }, /from 1 to 4/],
    [{ correct: "x" }, /from 1 to 4/],
    [{ correct: "1,2,3,4", multi: "on" }, /must be wrong/],
    [{ stem: "short" }, /10 characters/],
  ])("rejects %o", (patch, message) => {
    const r = NewQuizItem.safeParse({ ...base, ...patch });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(message);
  });
});

describe("QuizAnswerBody (API input)", () => {
  const ok = { attemptId: "6f1f3c1e-8a59-4d4e-9b6e-2d1d1f0a7b11", position: 3 };
  it("accepts an answer list or a skip", () => {
    expect(QuizAnswerBody.safeParse({ ...ok, answer: [0, 2] }).success).toBe(true);
    expect(QuizAnswerBody.safeParse({ ...ok, answer: [] }).success).toBe(true);
    expect(QuizAnswerBody.safeParse({ ...ok, answer: null }).success).toBe(true);
  });
  it("rejects out-of-range values", () => {
    expect(QuizAnswerBody.safeParse({ ...ok, answer: [5] }).success).toBe(false);
    expect(QuizAnswerBody.safeParse({ ...ok, answer: 1 }).success).toBe(false);
    expect(QuizAnswerBody.safeParse({ ...ok, position: 16, answer: [0] }).success).toBe(false);
    expect(QuizAnswerBody.safeParse({ ...ok, attemptId: "x", answer: [0] }).success).toBe(false);
  });
});

describe("nextStep (results page button)", () => {
  const app = { role_slug: "software-engineer", interview: null, quiz: null };
  it("points at the interview, then the quiz, only while the candidate can act", () => {
    expect(nextStep({ ...app, stage: "interview", status: "in_progress" })).toEqual({
      href: "/apply/software-engineer/interview",
      label: "Start the AI CV interview",
    });
    expect(nextStep({ ...app, stage: "interview", status: "advanced", interview: { ended_at: null } })?.label).toBe(
      "Continue the AI CV interview",
    );
    expect(nextStep({ ...app, stage: "interview", status: "in_progress", interview: { ended_at: "2026-10-07T10:00:00Z" } })).toBeNull();
    expect(nextStep({ ...app, stage: "quiz", status: "in_progress" })).toEqual({
      href: "/apply/software-engineer/quiz",
      label: "Start the role quiz",
    });
    expect(nextStep({ ...app, stage: "quiz", status: "in_progress", quiz: { submitted_at: null } })?.label).toBe("Continue the role quiz");
    expect(nextStep({ ...app, stage: "quiz", status: "awaiting_review", quiz: { submitted_at: "2026-10-07T10:00:00Z" } })).toBeNull();
    expect(nextStep({ ...app, stage: "interview", status: "awaiting_review" })).toBeNull();
    expect(nextStep({ ...app, stage: "quiz", status: "rejected" })).toBeNull();
    expect(nextStep({ ...app, stage: "work_1", status: "advanced" })).toBeNull();
  });
});

describe("MyResults schema", () => {
  it("parses the my_results() shape, including nulls before anything is graded", () => {
    const parsed = MyResults.parse([
      {
        application_id: "a1",
        role_slug: "business-analyst",
        role_title: "AI-native Business Analyst",
        stage: "quiz",
        status: "awaiting_review",
        below_hurdle: false,
        created_at: "2026-10-07T10:00:00Z",
        interview: {
          started_at: "2026-10-07T10:00:00Z",
          ended_at: "2026-10-07T10:20:00Z",
          end_reason: "completed",
          score: 72.5,
          criteria: [
            { key: "specificity", final_score: 4, feedback: "Concrete", under_review: false },
            { key: "ownership", final_score: null, feedback: null, under_review: true },
          ],
        },
        quiz: {
          started_at: "2026-10-07T11:00:00Z",
          submitted_at: "2026-10-07T11:10:00Z",
          raw_score: 9,
          pct: 60,
          topic_scores: { requirements: { correct: 2, total: 3 } },
        },
        decisions: [],
      },
      {
        application_id: "a2",
        role_slug: "software-engineer",
        role_title: "AI-native Software Engineer",
        stage: "interview",
        status: "in_progress",
        below_hurdle: true,
        created_at: "2026-10-07T10:00:00Z",
        interview: null,
        quiz: null,
        decisions: null,
      },
    ]);
    expect(parsed[0]!.interview!.criteria[1]!.under_review).toBe(true);
    expect(parsed[1]!.decisions).toEqual([]);
  });

  it("formats scores for candidates", () => {
    expect(fmtRubric(3)).toBe("3/5");
    expect(fmtRubric(3.5)).toBe("3.5/5");
    expect(fmtPct(53.3)).toBe("53%");
    expect(fmtPct(46.7)).toBe("47%");
  });
});
