import { describe, expect, it } from "vitest";
import { journey, stepDuration, type JourneyInput } from "@/components/results/journey";

const base: JourneyInput = { role_slug: "business-analyst", stage: "interview", status: "in_progress", interview: null, quiz: null, work: [] };
const states = (app: JourneyInput) => journey(app).flatMap((s) => s.steps.map((st) => `${st.key}:${st.state}`));

describe("journey", () => {
  it("groups the steps into work readiness, work assessment and real work, with role-specific work titles", () => {
    const j = journey(base);
    expect(j.map((s) => s.title)).toEqual(["Work readiness", "Work assessment", "Real work with us"]);
    expect(j[1].steps.map((s) => s.label)).toEqual(["Discovery & point of view", "Build & handoff"]);
    expect(journey({ ...base, role_slug: "software-engineer" })[1].steps.map((s) => s.label)).toEqual(["Harden & ship", "Architecture & cost plan"]);
  });

  it("marks done, current and upcoming steps", () => {
    expect(states(base)).toEqual([
      "reasoning:done", "interview:current", "quiz:upcoming", "work_1:upcoming", "work_2:upcoming", "live:upcoming", "decision:upcoming",
    ]);
    expect(states({ ...base, stage: "work_1" }).slice(0, 4)).toEqual(["reasoning:done", "interview:done", "quiz:done", "work_1:current"]);
  });

  it("shows a finished or held stage as with our team", () => {
    expect(states({ ...base, stage: "quiz", quiz: { submitted_at: "2026-10-08" } })[2]).toBe("quiz:review");
    expect(states({ ...base, status: "awaiting_review" })[1]).toBe("interview:review");
    expect(states({ ...base, stage: "grading", status: "submitted" })[4]).toBe("work_2:review");
    expect(states({ ...base, stage: "work_2", work: [{ app_stage: "work_2", title: "x", submitted_at: "2026-10-08" }] })[4]).toBe("work_2:review");
  });

  it("a closed application stops where it was; an advanced offer is done", () => {
    expect(states({ ...base, stage: "quiz", status: "rejected" }).slice(1, 4)).toEqual(["interview:done", "quiz:stopped", "work_1:upcoming"]);
    expect(states({ ...base, stage: "offer", status: "advanced" }).at(-1)).toBe("decision:done");
    expect(states({ ...base, stage: "live", status: "in_progress" })[5]).toBe("live:current");
  });

  it("says how long the next step takes", () => {
    expect(stepDuration("business-analyst", "interview")).toMatch(/25 to 30 minutes/);
    expect(stepDuration("software-engineer", "work_1")).toMatch(/6 hours.*72-hour/);
    expect(stepDuration("business-analyst", "live")).toBeNull();
  });
});
