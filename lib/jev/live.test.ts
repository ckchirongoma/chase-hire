import { describe, expect, it } from "vitest";
import { systemOne } from "./client";

// Live smoke test against the real JEV API. Runs only when TYPESAFE_API_KEY is set.
describe.skipIf(!process.env.TYPESAFE_API_KEY)("JEV live", () => {
  it("answers typed questions about an interview answer", async () => {
    const res = await systemOne("Candidate answered: 'We used some tools and it went well.'", {
      needs_probe: { type: "noul", instructions: "The answer lacks specifics, so a follow-up probe is needed." },
    });
    expect(res).not.toBeNull();
    expect(res!.answers.needs_probe.noul).toBeGreaterThan(0.5);
  }, 15_000);
});
