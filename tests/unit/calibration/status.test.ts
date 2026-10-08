import { describe, expect, it } from "vitest";
import { calibrationForGrade, staleReasons, type LatestCalibration } from "@/lib/calibration/status";

const RUN: LatestCalibration = {
  id: "run-1",
  rubricKey: "ba_part2",
  rubricVersion: 1,
  rubricId: "rubric-v1",
  model: "stub/grader",
  promptVersions: ["answer-key-grader.v1", "grader-criterion.v1"],
  finishedAt: "2026-10-01T10:00:00Z",
  passed: false,
  perCriterion: {
    data_model: { status: "live", icc: 0.9, n: 20 },
    mvp: { status: "review", icc: 0.7, n: 20 },
    handoff: { status: "human_only", icc: 0.4, n: 20 },
  },
};
const CURRENT = { rubricId: "rubric-v1", rubricVersion: 1, model: "stub/grader", promptVersion: "grader-criterion.v1" };

describe("calibrationForGrade (docs/09 §8.3)", () => {
  it("not calibrated (no finished run): grades as before", () => {
    expect(calibrationForGrade(null, "mvp", CURRENT)).toEqual({ status: null, stale: [], reason: null, aiFinal: true });
  });

  it("a current run: live counts, review flags, human_only flags and takes the AI score out", () => {
    expect(calibrationForGrade(RUN, "data_model", CURRENT)).toMatchObject({ status: "live", reason: null, aiFinal: true });
    expect(calibrationForGrade(RUN, "mvp", CURRENT)).toMatchObject({ status: "review", reason: "calibration: review", aiFinal: true });
    expect(calibrationForGrade(RUN, "handoff", CURRENT)).toMatchObject({ status: "human_only", reason: "calibration: human_only", aiFinal: false });
    // A criterion the run doesn't calibrate (platform-computed) is untouched.
    expect(calibrationForGrade(RUN, "import", CURRENT)).toMatchObject({ status: null, reason: null, aiFinal: true });
  });

  it("a stale run (rubric, model or prompt changed) is never treated as live", () => {
    for (const changed of [
      { ...CURRENT, rubricId: "rubric-v2", rubricVersion: 2 },
      { ...CURRENT, model: "other/model" },
      { ...CURRENT, promptVersion: "grader-criterion.v2" },
    ]) {
      const live = calibrationForGrade(RUN, "data_model", changed);
      expect(live.stale.length).toBeGreaterThan(0);
      expect(live.aiFinal).toBe(true);
      expect(live.reason).toMatch(/^calibration: stale, re-run the gold set \(/);
      expect(calibrationForGrade(RUN, "mvp", changed).reason).toMatch(/calibration: stale/);
      // Human-only stays human-only until a re-run says otherwise.
      const human = calibrationForGrade(RUN, "handoff", changed);
      expect(human).toMatchObject({ aiFinal: false });
      expect(human.reason).toMatch(/^calibration: human_only; calibration: stale/);
    }
  });

  it("staleReasons names what changed", () => {
    expect(staleReasons(RUN, CURRENT)).toEqual([]);
    expect(staleReasons(RUN, { ...CURRENT, rubricId: "rubric-v2", rubricVersion: 2, model: "m2", promptVersion: "x.v9" })).toEqual([
      "rubric v1 → v2",
      "model stub/grader → m2",
      "prompt x.v9 not in the run",
    ]);
    // Same version number, different rubric row (a re-seeded rubric) is still a different rubric.
    expect(staleReasons(RUN, { ...CURRENT, rubricId: "other-id" })).toEqual(["rubric v1 → v1"]);
  });
});
