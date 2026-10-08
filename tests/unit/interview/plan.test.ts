import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jev", () => ({ systemOne: vi.fn() }));
import { systemOne } from "@/lib/jev";
import { ParsedCv } from "@/lib/cv/schema";
import {
  buildPlan,
  closestByKeywords,
  consistencyIssues,
  flattenClaims,
  keywords,
  longestQuantified,
  monthIndex,
  recentRoles,
  rolesByRecency,
  unevidencedSkills,
  type RoleInfo,
} from "@/lib/interview/plan";
import { MAX_TOPICS, PROBES, SITUATIONAL, openingQuestion } from "@/lib/interview/script";

const WARMUP_QUESTION = openingQuestion("AI-native Business Analyst");

const jev = vi.mocked(systemOne);

const BA: RoleInfo = {
  slug: "business-analyst",
  title: "AI-native Business Analyst",
  summary: "Find what the client hasn't noticed and build the first working version.",
  spec_md: "Run discovery workshops with operations teams; dig into messy spreadsheets; write requirements developers can build from.",
  salary_min: 30000,
  salary_max: 32500,
  location_note: "Remote within South Africa.",
};

const NOW = new Date("2026-10-08T00:00:00Z");

// Roles deliberately listed oldest-first to prove recency is by date, not CV order.
const cv = ParsedCv.parse({
  identity: {},
  skills: ["Excel", "SQL", "Facilitation", "Power BI"],
  roles: [
    {
      employer: "Old Co",
      title: "Junior Analyst",
      start: "2017-01",
      end: "2019-06",
      claims: [
        { id: "c1", text: "Cleaned a 50,000-row customer dataset and removed 3,000 duplicates", quantified: true, skills: ["Excel"] },
        { id: "c2", text: "Ran discovery workshops with operations managers to capture requirements", quantified: false, skills: ["Facilitation"] },
      ],
    },
    {
      employer: "New Co",
      title: "Data Analyst",
      start: "2019-07",
      end: "present",
      claims: [
        { id: "c3", text: "Built dashboards for the sales team", quantified: false, skills: ["Power BI"] },
        { id: "c4", text: "Automated a weekly reporting pipeline that saved 20 hours a week across 4 teams", quantified: true, skills: ["Python"] },
        { id: "c5", text: "Cut month-end close by 2 days", quantified: true, skills: [] },
      ],
    },
  ],
});

const choice = (id: string, probs: Record<string, number>) => ({ type: "choice" as const, choice: id, confidence: probs[id], probabilities: probs });

beforeEach(() => {
  jev.mockReset();
});

describe("claim helpers", () => {
  it("orders roles by end then start date, keeping CV order when dates are unusable", () => {
    expect(rolesByRecency(cv.roles).map((r) => r.employer)).toEqual(["New Co", "Old Co"]);
    const undated = ParsedCv.parse({ roles: [{ employer: "A", claims: [] }, { employer: "B", end: "2020-01", claims: [] }] });
    expect(rolesByRecency(undated.roles).map((r) => r.employer)).toEqual(["A", "B"]);
  });

  it("flattens claims in recency order", () => {
    expect(flattenClaims(cv).map((c) => c.id)).toEqual(["c3", "c4", "c5", "c1", "c2"]);
    expect(flattenClaims(null)).toEqual([]);
  });

  it("fallbacks: longest quantified claim, keyword overlap with the role", () => {
    const flat = flattenClaims(cv);
    expect(longestQuantified(flat)?.id).toBe("c4");
    expect(closestByKeywords(flat, BA)?.id).toBe("c2");
    expect(keywords("Running the workshops")).toEqual(new Set(["running", "workshop"]));
  });
});

describe("CV checks", () => {
  it("monthIndex handles year-month, year only, 'present' and junk", () => {
    expect(monthIndex("2021-03")).toBe(2021 * 12 + 2);
    expect(monthIndex("2021")).toBe(2021 * 12 + 11);
    expect(monthIndex("Present")).toBe(9999 * 12 + 11);
    expect(monthIndex("soon")).toBeNull();
    expect(monthIndex(null)).toBeNull();
  });

  it("recentRoles keeps roles current or ended within 5 years, most recent first", () => {
    const roles = ParsedCv.parse({
      roles: [
        { employer: "Edge", start: "2019-01", end: "2021-10", claims: [] },
        { employer: "Old", start: "2018-01", end: "2021-09", claims: [] },
        { employer: "Now", start: "2022-01", end: "present", claims: [] },
      ],
    });
    expect(recentRoles(roles, NOW).map((r) => r.employer)).toEqual(["Now", "Edge"]);
    expect(recentRoles(null, NOW)).toEqual([]);
  });

  it("consistencyIssues: ends before it starts, overlapping roles (3+ months), gaps (6+ months)", () => {
    const messy = ParsedCv.parse({
      roles: [
        { employer: "Backwards", title: "Analyst", start: "2020-05", end: "2019-01", claims: [] },
        { employer: "X", start: "2010-01", end: "2012-06", claims: [] },
        { employer: "Y", start: "2012-03", end: "2013-01", claims: [] },
        { employer: "Z", start: "2014-01", end: "present", claims: [] },
      ],
    });
    const issues = consistencyIssues(messy);
    expect(issues[0]).toBe("Your CV lists Analyst at Backwards as ending (2019-01) before it started (2020-05).");
    expect(issues).toContain("Your CV shows two roles at the same time: X (2010-01 to 2012-06) and Y (2012-03 to 2013-01).");
    expect(issues).toContain("Your CV shows a gap between Y (ended 2013-01) and Z (started 2014-01).");
    // Back-to-back roles and a short overlap are not issues.
    const clean = ParsedCv.parse({
      roles: [
        { employer: "A", start: "2018-01", end: "2020-02", claims: [] },
        { employer: "B", start: "2020-01", end: "present", claims: [] },
      ],
    });
    expect(consistencyIssues(clean)).toEqual([]);
    expect(consistencyIssues(null)).toEqual([]);
  });

  it("unevidencedSkills: listed skills no claim mentions or tags (case-insensitive, de-duplicated)", () => {
    const c = ParsedCv.parse({
      skills: ["SQL", "Excel", "sql", "Power BI", "C++", "R"],
      roles: [{ employer: "A", claims: [{ text: "Built an Excel model for 4 regions", skills: ["Power BI"] }] }],
    });
    expect(unevidencedSkills(c)).toEqual(["SQL", "C++"]);
    expect(unevidencedSkills(null)).toEqual([]);
  });
});

describe("buildPlan", () => {
  it("opens with role fit, then matches CV claims to the role's requirements (fallback rules without JEV)", async () => {
    jev.mockResolvedValue(null);
    const plan = await buildPlan({ cv, cvId: "cv-1", role: BA, now: NOW });
    expect(plan.v).toBe(2);
    const [, questions] = jev.mock.calls[0];
    expect(Object.keys(questions)).toEqual(["req_data", "req_discovery", "req_prototype", "impressive_claim"]); // one unevidenced skill: nothing to choose
    // Requirement keywords pick the evidence; New Co (the only recent role) is already covered by c3.
    expect(plan.claims.map((c) => [c.id, c.why, c.requirement?.key ?? null])).toEqual([
      ["c1", "role_requirement", "data"],
      ["c2", "role_requirement", "discovery"],
      ["c3", "role_requirement", "prototype"],
      ["c4", "impressive_quantified", null],
      ["s1", "skill_unevidenced", null],
    ]);
    expect(plan.claims[4]).toMatchObject({ kind: "skill", text: "SQL" });
    expect(plan.selection.via).toBe("fallback");
    expect(plan.questions.map((q) => q.step)).toEqual(["warmup", "claim", "claim", "claim", "claim", "claim", "situational", "logistics"]);
    expect(plan.questions.map((q) => q.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(plan.questions[0].text).toBe(WARMUP_QUESTION);
    expect(plan.questions[0].text).toContain("strong fit for the AI-native Business Analyst role");
    expect(plan.questions[1].text).toBe(
      "This role involves digging into messy spreadsheets and system data to find what's missing or wrong. Your CV says you 'cleaned a 50,000-row customer dataset and removed 3,000 duplicates'. Walk me through what you personally did, which tools you used, and how you measured the result.",
    );
    expect(plan.questions[4].text).toBe(
      "Your CV says you 'automated a weekly reporting pipeline that saved 20 hours a week across 4 teams'. Walk me through what you personally did, which tools you used, and how you measured the result.",
    );
    expect(plan.questions[5].text).toMatch(/^Your CV lists SQL as a skill\./);
    expect(plan.questions[6].text).toBe(SITUATIONAL["business-analyst"]);
    expect(plan.questions[7].text).toContain("R30,000–R32,500 a month plus year-end profit share");
    expect(plan.questions[7].text).toContain("when could you start?");
    expect(plan.probes).toEqual(PROBES);
    expect(plan.cvId).toBe("cv-1");
  });

  it("uses JEV's requirement matches in one call, takes the next-best unused claim, and asks about a gap", async () => {
    jev.mockResolvedValue({
      model: "jev-1.13.0",
      ms: 500,
      answers: {
        req_data: choice("c1", { c1: 0.8, c3: 0.1, none: 0.1 }),
        // JEV's top pick is the claim the first requirement already took: use the next-best.
        req_discovery: choice("c1", { c1: 0.5, c2: 0.4, none: 0.1 }),
        req_prototype: choice("none", { none: 0.7, c3: 0.2, c4: 0.1 }),
        impressive_claim: choice("c5", { c5: 0.7, c4: 0.2, c1: 0.1 }),
      },
    } as never);
    const plan = await buildPlan({ cv, cvId: null, role: BA, now: NOW });
    expect(jev).toHaveBeenCalledTimes(1);
    const [state, questions] = jev.mock.calls[0];
    const q = questions as Record<string, { criteria: object; instructions: string }>;
    expect(Object.keys(q.req_data.criteria)).toEqual(["c3", "c4", "c5", "c1", "c2", "none"]);
    expect(q.req_data.instructions).toContain("This role involves digging into messy spreadsheets");
    expect(JSON.stringify(state)).toContain("discovery workshops");
    expect(plan.claims.map((c) => [c.id, c.why])).toEqual([
      ["c1", "role_requirement"],
      ["c2", "role_requirement"],
      ["c4", "recent_role"],
      ["c5", "impressive_quantified"],
      ["q_prototype", "requirement_gap"],
      ["s1", "skill_unevidenced"],
    ]);
    expect(plan.claims[4]).toMatchObject({ kind: "gap", requirement: { key: "prototype" } });
    expect(plan.questions.find((x) => x.claimId === "q_prototype")?.text).toBe(
      "This role involves building a first working version of a solution yourself, with AI tools or code. That doesn't come through clearly on your CV. What's the closest you've done to it? Pick one example and walk me through what you personally did, which tools you used, and how it turned out.",
    );
    expect(plan.selection).toMatchObject({
      via: "jev",
      model: "jev-1.13.0",
      impressive: { choice: "c5" },
      requirements: { data: { choice: "c1" }, discovery: { choice: "c1" }, prototype: { choice: "none" } },
    });
  });

  it("caps at 6 topics by priority: requirements, a CV gap, the latest role, a requirement gap, a skill", async () => {
    const busy = ParsedCv.parse({
      skills: ["Tableau", "Python"],
      roles: [
        { employer: "A", title: "Lead", start: "2024-01", end: "present", claims: [
          { id: "a1", text: "Grew revenue by 30% across 12 regions", quantified: true },
          { id: "a2", text: "Wrote the weekly board pack", quantified: false },
        ] },
        { employer: "B", title: "Analyst", start: "2022-01", end: "2023-12", claims: [{ id: "b1", text: "Cut costs by 10%", quantified: true }] },
        { employer: "C", title: "Junior", start: "2020-06", end: "2021-12", claims: [{ id: "c1", text: "Migrated 3 systems", quantified: true }] },
        { employer: "D", title: "Intern", start: "2015-01", end: "2016-01", claims: [
          { id: "d1", text: "Trained 50 people on Excel and dashboards", quantified: true },
          { id: "d2", text: "Led workshops with operations teams to gather requirements", quantified: false },
        ] },
      ],
    });
    jev.mockResolvedValue({ model: "jev", ms: 1, answers: { key_skill: choice("s1", { s0: 0.3, s1: 0.7 }) } } as never);
    const plan = await buildPlan({ cv: busy, cvId: null, role: BA, now: NOW });
    const [, questions] = jev.mock.calls[0];
    expect(Object.keys(questions)).toEqual(["req_data", "req_discovery", "req_prototype", "impressive_claim", "key_skill"]);
    expect(plan.claims).toHaveLength(MAX_TOPICS);
    // Older recent roles (lowest priority) are dropped; requirement topics lead, the rest keep their natural order.
    expect(plan.claims.map((c) => [c.id, c.why])).toEqual([
      ["d1", "role_requirement"],
      ["d2", "role_requirement"],
      ["a1", "recent_role"],
      ["q_prototype", "requirement_gap"],
      ["s1", "skill_unevidenced"],
      ["k1", "cv_consistency"],
    ]);
    expect(plan.claims[4].text).toBe("Python");
    expect(plan.claims[5].text).toBe("Your CV shows a gap between Intern at D (ended 2016-01) and Junior at C (started 2020-06).");
    expect(plan.questions.find((q) => q.claimId === "k1")?.text).toMatch(/Can you walk me through that period/);
    expect(plan.questions).toHaveLength(1 + MAX_TOPICS + 2);
  });

  it("uses role titles and a requirement gap when the CV is thin, then generic topics", async () => {
    jev.mockResolvedValue(null);
    const thin = ParsedCv.parse({
      roles: [
        { employer: "Acme", title: "Analyst", start: "2022-01", end: "present", claims: [{ text: "Reduced churn by 5%" }] },
        { employer: "Beta", title: "Intern", start: "2021-01", end: "2021-12", claims: [] },
      ],
    });
    const plan = await buildPlan({ cv: thin, cvId: null, role: BA, now: NOW });
    expect(plan.claims.map((c) => [c.id, c.kind])).toEqual([
      ["c1", "claim"],
      ["r2", "role"],
      ["q_data", "gap"],
    ]);
    expect(plan.questions[2].text).toMatch(/^Your CV lists your role as Intern at Beta\. Pick one piece of work/);

    jev.mockClear();
    const none = await buildPlan({ cv: null, cvId: null, role: { ...BA, slug: "software-engineer" }, now: NOW });
    expect(jev).not.toHaveBeenCalled(); // nothing to choose between
    expect(none.claims.map((c) => c.kind)).toEqual(["generic", "generic", "gap"]);
    expect(none.questions[1].text).toMatch(/^Tell me about a recent piece of work you are proud of\./);
    expect(none.questions[3].text).toMatch(/^This role involves taking an existing app and making it secure/);
    expect(none.questions[4].text).toBe(SITUATIONAL["software-engineer"]);
    expect(new Set(none.questions.map((q) => q.text)).size).toBe(6);
  });
});
