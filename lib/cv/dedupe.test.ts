import { describe, expect, it } from "vitest";
import { classifySimilarity, identityMatches } from "./dedupe";

describe("classifySimilarity (default thresholds 0.85 / 0.92)", () => {
  const cases: [number, string | null][] = [
    [0.8499, null],
    [0.85, "semantic_review"],
    [0.9199, "semantic_review"],
    [0.92, "semantic_high"],
    [1.0, "semantic_high"],
    [0, null],
    [-0.5, null],
    [Number.NaN, null],
  ];
  for (const [sim, expected] of cases) {
    it(`${sim} → ${expected}`, () => expect(classifySimilarity(sim)).toBe(expected));
  }

  it("accepts custom thresholds", () => {
    const t = { semanticHigh: 0.95, semanticReview: 0.9 };
    expect(classifySimilarity(0.93, t)).toBe("semantic_review");
    expect(classifySimilarity(0.95, t)).toBe("semantic_high");
    expect(classifySimilarity(0.89, t)).toBeNull();
  });
});

describe("identityMatches", () => {
  const me = {
    email: "Test.Candidate@example.co.za",
    phone: "082 555 0101",
    linkedin: "https://www.linkedin.com/in/test-candidate/",
    github: "github.com/test-candidate",
  };

  it("matches on normalised values across formats", () => {
    const other = {
      email: " test.candidate@EXAMPLE.co.za",
      phone: "+27 82 555 0101",
      linkedin: "linkedin.com/in/Test-Candidate?trk=x",
      github: "https://github.com/Test-Candidate/repo",
    };
    expect(identityMatches(me, other)).toEqual(["email", "phone", "linkedin", "github"]);
  });

  it("matches a plus-addressed email", () => {
    expect(identityMatches({ email: "a.b@gmail.com" }, { email: "ab+retake@gmail.com" })).toEqual(["email"]);
  });

  it("returns only the fields that match", () => {
    expect(identityMatches(me, { email: "someone@else.com", phone: "0825550101" })).toEqual(["phone"]);
  });

  it("ignores null, missing and unusable values", () => {
    expect(identityMatches({ email: null, phone: "0" }, { email: null, phone: "0" })).toEqual([]);
    expect(identityMatches({}, {})).toEqual([]);
    expect(identityMatches({ linkedin: "LinkedIn" }, { linkedin: "LinkedIn" })).toEqual([]);
  });
});
