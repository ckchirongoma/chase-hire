import { describe, expect, it } from "vitest";
import { cleanScores, formatNotes, kindsForRole, parseNotes, scorecardTotal } from "@/lib/live/scorecard";

const KEYS = ["a", "b", "c", "d"];

describe("scorecardTotal (docs/09 §2 normalisation)", () => {
  it("maps the mean question score onto 0–100 (1 → 0, 3 → 50, 5 → 100)", () => {
    expect(scorecardTotal({ a: 1, b: 1, c: 1, d: 1 }, KEYS)).toBe(0);
    expect(scorecardTotal({ a: 3, b: 3, c: 3, d: 3 }, KEYS)).toBe(50);
    expect(scorecardTotal({ a: 5, b: 5, c: 5, d: 5 }, KEYS)).toBe(100);
    // mean 3.5 → 62.5
    expect(scorecardTotal({ a: 3, b: 4, c: 2, d: 5 }, KEYS)).toBe(62.5);
    // six questions, mean 23/6 = 3.833… → 70.8 (1 dp)
    expect(scorecardTotal({ q1: 4, q2: 4, q3: 3, q4: 4, q5: 4, q6: 4 }, ["q1", "q2", "q3", "q4", "q5", "q6"])).toBe(70.8);
  });

  it("is null until every question has an integer score 1–5", () => {
    expect(scorecardTotal({ a: 3, b: 3, c: 3 }, KEYS)).toBeNull();
    expect(scorecardTotal({ a: 3, b: 3, c: 3, d: 6 }, KEYS)).toBeNull();
    expect(scorecardTotal({ a: 3, b: 3, c: 3, d: 2.5 }, KEYS)).toBeNull();
    expect(scorecardTotal({}, [])).toBeNull();
  });

  it("ignores scores for questions that are not on the card", () => {
    expect(scorecardTotal({ a: 5, b: 5, c: 5, d: 5, z: 1 }, KEYS)).toBe(100);
  });
});

describe("cleanScores", () => {
  it("keeps 1–5 integers for the card's questions and reports missing and invalid ones", () => {
    expect(cleanScores({ a: "4", b: 2, c: "", d: "9", z: 3 }, KEYS)).toEqual({ scores: { a: 4, b: 2 }, missing: ["c"], invalid: ["d"] });
    expect(cleanScores({ a: "2.5", b: "x", c: null }, KEYS)).toEqual({ scores: {}, missing: ["c", "d"], invalid: ["a", "b"] });
  });
});

describe("kindsForRole (docs/09 §2 live components)", () => {
  it("BA: panel, defence, elicitation; SWE: panel, defence, exec scenario", () => {
    expect(kindsForRole("business-analyst")).toEqual(["panel_interview", "live_defence", "live_elicitation"]);
    expect(kindsForRole("software-engineer")).toEqual(["panel_interview", "live_defence", "exec_scenario"]);
  });
});

describe("notes", () => {
  it("round-trips per-question and general notes", () => {
    const per = { a: "Specific: named the table and the index.", c: "Line one\nLine two" };
    const text = formatNotes(per, "Strong overall.", KEYS);
    expect(text).toBe("[a] Specific: named the table and the index.\n\n[c] Line one\nLine two\n\n[general] Strong overall.");
    expect(parseNotes(text, KEYS)).toEqual({ perQuestion: per, general: "Strong overall." });
  });

  it("stores general-only notes as plain text, and null when empty", () => {
    expect(formatNotes({}, "  Just general  ", KEYS)).toBe("Just general");
    expect(parseNotes("Just general", KEYS)).toEqual({ perQuestion: {}, general: "Just general" });
    expect(formatNotes({ a: "  " }, "", KEYS)).toBeNull();
    expect(parseNotes(null, KEYS)).toEqual({ perQuestion: {}, general: "" });
  });

  it("treats unknown [headers] as text", () => {
    expect(parseNotes("[zz] not a question\n[a] answer", KEYS)).toEqual({ perQuestion: { a: "answer" }, general: "[zz] not a question" });
  });
});
