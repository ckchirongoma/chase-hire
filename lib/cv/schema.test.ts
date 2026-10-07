import { describe, expect, it } from "vitest";
import { ParsedCv } from "./schema";

describe("ParsedCv", () => {
  it("accepts a full doc-10 shaped object", () => {
    const cv = ParsedCv.parse({
      identity: {
        full_name: "Test Candidate",
        email: "test.candidate@example.co.za",
        phone: "082 555 0101",
        linkedin: "linkedin.com/in/test-candidate",
        github: null,
        city: "Cape Town",
      },
      education: [{ institution: "University of Example", qualification: "BCom", year: "2018" }],
      roles: [
        {
          employer: "Example Retail Group",
          title: "Senior Business Analyst",
          start: "2022-03",
          end: "present",
          claims: [{ id: "c1", text: "Cut close from 10 days to 4", quantified: true, skills: ["process mapping"] }],
        },
      ],
      skills: ["SQL"],
      links: ["linkedin.com/in/test-candidate"],
      summary: "BA with six years of experience.",
    });
    expect(cv.identity.full_name).toBe("Test Candidate");
    expect(cv.roles[0].claims[0]).toEqual({
      id: "c1",
      text: "Cut close from 10 days to 4",
      quantified: true,
      skills: ["process mapping"],
    });
  });

  it("is lenient with sparse or messy model output", () => {
    const cv = ParsedCv.parse({
      identity: null,
      education: [{ institution: "UCT", qualification: "", year: 2019 }],
      roles: [
        {
          employer: "Acme",
          title: "BA",
          claims: [
            { text: "Saved R2m" },
            { id: "c1", text: "Ran workshops", quantified: "false", skills: null },
            { id: "c1", text: "Duplicate id" },
            { id: "c9", text: null },
          ],
        },
      ],
      skills: ["SQL", "", null],
      links: null,
      race: "should be stripped",
    });

    expect(cv.identity).toEqual({
      full_name: null, email: null, phone: null, linkedin: null, github: null, city: null,
    });
    expect(cv.education[0]).toEqual({ institution: "UCT", qualification: null, year: "2019" });
    expect(cv.roles[0].start).toBeNull();
    expect(cv.roles[0].claims).toEqual([
      { id: "c2", text: "Saved R2m", quantified: true, skills: [] },
      { id: "c1", text: "Ran workshops", quantified: false, skills: [] },
      { id: "c3", text: "Duplicate id", quantified: false, skills: [] },
    ]);
    expect(cv.skills).toEqual(["SQL"]);
    expect(cv.links).toEqual([]);
    expect(cv.summary).toBeNull();
    expect(cv).not.toHaveProperty("race");
  });

  it("accepts an empty object", () => {
    const cv = ParsedCv.parse({});
    expect(cv.roles).toEqual([]);
    expect(cv.education).toEqual([]);
  });
});
