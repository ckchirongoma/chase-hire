import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jev", () => ({ systemOne: vi.fn() }));
import { systemOne } from "@/lib/jev";
import { ParsedCv } from "@/lib/cv/schema";
import { buildPlan, closestByKeywords, flattenClaims, keywords, longestQuantified, rolesByRecency, type RoleInfo } from "@/lib/interview/plan";
import { PROBES, SITUATIONAL, WARMUP_QUESTION } from "@/lib/interview/script";

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

// Roles deliberately listed oldest-first to prove recency is by date, not CV order.
const cv = ParsedCv.parse({
  identity: {},
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

describe("buildPlan", () => {
  it("falls back to deterministic rules when JEV is unavailable", async () => {
    jev.mockResolvedValue(null);
    const plan = await buildPlan({ cv, cvId: "cv-1", role: BA });
    expect(plan.claims.map((c) => [c.id, c.why])).toEqual([
      ["c3", "recent_role"],
      ["c4", "impressive_quantified"],
      ["c2", "closest_to_role"],
    ]);
    expect(plan.selection.via).toBe("fallback");
    expect(plan.questions).toHaveLength(6);
    expect(plan.questions.map((q) => q.step)).toEqual(["warmup", "claim", "claim", "claim", "situational", "logistics"]);
    expect(plan.questions.map((q) => q.no)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(plan.questions[0].text).toBe(WARMUP_QUESTION);
    expect(plan.questions[1].text).toBe(
      "Your CV says you 'built dashboards for the sales team'. Walk me through what you personally did, which tools you used, and how you measured the result.",
    );
    expect(plan.questions[4].text).toBe(SITUATIONAL["business-analyst"]);
    expect(plan.questions[5].text).toContain("R30,000–R32,500 a month plus year-end profit share");
    expect(plan.questions[5].text).toContain("when could you start?");
    expect(plan.probes).toEqual(PROBES);
    expect(plan.cvId).toBe("cv-1");
  });

  it("uses JEV's choices in one call, and de-duplicates by probability rank", async () => {
    jev.mockResolvedValue({
      model: "jev-1.13.0",
      ms: 500,
      answers: {
        impressive_claim: choice("c1", { c4: 0.2, c5: 0.1, c1: 0.7 }),
        // JEV's top pick for "closest" is the claim already chosen as (b): take the next-best.
        closest_claim: choice("c1", { c4: 0.1, c5: 0.3, c1: 0.4, c2: 0.2 }),
      },
    } as never);
    const plan = await buildPlan({ cv, cvId: null, role: BA });
    expect(jev).toHaveBeenCalledTimes(1);
    const [state, questions] = jev.mock.calls[0];
    expect(Object.keys(questions)).toEqual(["impressive_claim", "closest_claim"]);
    expect(Object.keys((questions as Record<string, { criteria: object }>).impressive_claim.criteria)).toEqual(["c4", "c5", "c1"]);
    expect(JSON.stringify(state)).toContain("discovery workshops");
    expect(plan.claims.map((c) => [c.id, c.why])).toEqual([
      ["c3", "recent_role"],
      ["c1", "impressive_quantified"],
      ["c5", "closest_to_role"],
    ]);
    expect(plan.selection).toMatchObject({ via: "jev", model: "jev-1.13.0", impressive: { choice: "c1" }, closest: { choice: "c1" } });
  });

  it("uses role titles when the CV has fewer than 3 claims, then generic topics", async () => {
    jev.mockResolvedValue(null);
    const thin = ParsedCv.parse({
      roles: [
        { employer: "Acme", title: "Analyst", start: "2022-01", end: "present", claims: [{ text: "Reduced churn by 5%" }] },
        { employer: "Beta", title: "Intern", start: "2021-01", end: "2021-12", claims: [] },
      ],
    });
    const plan = await buildPlan({ cv: thin, cvId: null, role: BA });
    expect(jev).not.toHaveBeenCalled(); // nothing to choose between
    expect(plan.claims.map((c) => [c.id, c.kind])).toEqual([
      ["c1", "claim"],
      ["r1", "role"],
      ["r2", "role"],
    ]);
    expect(plan.questions[2].text).toMatch(/^Your CV lists your role as Analyst at Acme\. Pick one piece of work/);

    const none = await buildPlan({ cv: null, cvId: null, role: { ...BA, slug: "software-engineer" } });
    expect(none.claims.map((c) => c.kind)).toEqual(["generic", "generic", "generic"]);
    expect(none.questions[1].text).toMatch(/^Tell me about a recent piece of work you are proud of\./);
    expect(none.questions[4].text).toBe(SITUATIONAL["software-engineer"]);
    expect(new Set(none.questions.map((q) => q.text)).size).toBe(6);
  });

  it("falls back per question when a JEV choice is missing", async () => {
    jev.mockResolvedValue({ model: "jev", ms: 1, answers: { impressive_claim: choice("c5", { c4: 0.1, c5: 0.8, c1: 0.1 }) } } as never);
    const plan = await buildPlan({ cv, cvId: null, role: BA });
    expect(plan.claims.map((c) => c.id)).toEqual(["c3", "c5", "c2"]);
  });
});
