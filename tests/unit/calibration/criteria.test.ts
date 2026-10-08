import { describe, expect, it } from "vitest";
import { calibrationLeaves, humanScoresFromForm, HumanScores, isCalibrated, readHumanScores, scoredByBoth } from "@/lib/calibration/criteria";
import { driftAgreement, driftPicks, hash32 } from "@/lib/calibration/drift";
import { WORK_RUBRICS } from "@/lib/grading/rubrics";

const leavesOf = (key: string) => calibrationLeaves(WORK_RUBRICS.find((r) => r.key === key)!.criteria).map((l) => l.key);

describe("calibrationLeaves", () => {
  it("BA Part 1: gap recall, elicitation quality (not the computed yield), every POV and exec-comms sub, success criteria, research", () => {
    const keys = leavesOf("ba_part1");
    expect(keys).toContain("gap_recall");
    expect(keys).toContain("elicitation.quality");
    expect(keys).not.toContain("elicitation.yield");
    expect(keys.filter((k) => k.startsWith("spiky_pov."))).toHaveLength(7);
    expect(keys.filter((k) => k.startsWith("exec_comms."))).toHaveLength(6);
    expect(keys).toEqual(expect.arrayContaining(["success_criteria", "research"]));
    expect(keys.some((k) => k === "spiky_pov" || k === "exec_comms" || k === "elicitation")).toBe(false);
  });

  it("SWE Test 1: fault points and communication, never the harness-computed criteria", () => {
    expect(leavesOf("swe_test1")).toEqual(["s1_fault_discovery", "s9_communication"]);
  });

  it("SWE Test 2 and BA Part 2 calibrate every judged leaf", () => {
    expect(leavesOf("swe_test2")).toContain("answer_key");
    expect(leavesOf("swe_test2").filter((k) => k.startsWith("exec_comms."))).toHaveLength(10);
    expect(leavesOf("ba_part2")).toEqual(["data_model", "mvp", "handoff", "exec_comms_loom.e1", "exec_comms_loom.e3", "exec_comms_loom.e5", "exec_comms_loom.e8", "judgement"]);
  });

  it("isCalibrated: llm and judge-mapped computations yes; platform computations no", () => {
    const base = { key: "x", title: "X", weight: 1, description: "", anchors: {}, evidence_required: false };
    expect(isCalibrated({ ...base, method: "llm", prompt: "grader-criterion" })).toBe(true);
    expect(isCalibrated({ ...base, method: "computed", computation: "gap_recall", prompt: "gap-recall-grader" })).toBe(true);
    expect(isCalibrated({ ...base, method: "computed", computation: "elicitation_yield" })).toBe(false);
    expect(isCalibrated({ ...base, method: "computed", computation: "harness_import", prompt: "grader-criterion" })).toBe(false);
  });
});

describe("human scores", () => {
  it("parses the two raters' form fields; blank means not scored", () => {
    const r = humanScoresFromForm({ "h1:a": "4", "h2:a": "5", "h1:b": "", "h2:b": "3", "h1:c": "", "h2:c": "", "h1:d": "6" }, ["a", "b", "c", "d"]);
    expect(r).toEqual({ scores: { a: [4, 5], b: [null, 3] }, invalid: ["d"] });
    expect(HumanScores.safeParse(r.scores).success).toBe(true);
  });

  it("reads stored scores leniently", () => {
    expect(readHumanScores({ a: [4, 5], b: [9, "x"], c: "nope", "spiky_pov.p1": [3] })).toEqual({ a: [4, 5], b: [null, null], "spiky_pov.p1": [3, null] });
    expect(readHumanScores(null)).toEqual({});
    expect(readHumanScores([1, 2])).toEqual({});
  });

  it("counts leaves scored by both raters", () => {
    expect(scoredByBoth({ a: [4, 5], b: [null, 3] }, ["a", "b", "c"])).toBe(1);
  });

  it("the stored shape rejects out-of-range scores and odd keys", () => {
    expect(HumanScores.safeParse({ a: [0, 5] }).success).toBe(false);
    expect(HumanScores.safeParse({ "Bad Key": [1, 2] }).success).toBe(false);
  });
});

describe("drift check (docs/09 §8.4)", () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ id: `sub-${String(i).padStart(3, "0")}` }));

  it("picks 3 per complete block of 25, stably", () => {
    const a = driftPicks(items, "ba_part1");
    expect(a.map((b) => b.block)).toEqual([1, 2]); // 60 items: two complete blocks, 10 waiting
    for (const b of a) {
      expect(b.picks).toHaveLength(3);
      expect(new Set(b.picks.map((p) => p.id)).size).toBe(3);
    }
    expect(a[0].picks.every((p) => items.indexOf(p) < 25)).toBe(true);
    expect(a[1].picks.every((p) => items.indexOf(p) >= 25 && items.indexOf(p) < 50)).toBe(true);
    expect(driftPicks(items, "ba_part1")).toEqual(a);
    // Adding later submissions never changes earlier blocks' picks.
    expect(driftPicks([...items, ...items.map((x) => ({ id: `${x.id}-b` }))], "ba_part1").slice(0, 2)).toEqual(a);
  });

  it("differs by rubric and has no picks before 25", () => {
    expect(driftPicks(items, "ba_part1")[0].picks).not.toEqual(driftPicks(items, "swe_test2")[0].picks);
    expect(driftPicks(items.slice(0, 24), "x")).toEqual([]);
  });

  it("measures agreement as share within 1 point and mean absolute difference", () => {
    expect(driftAgreement([{ ai: 3, human: 3 }, { ai: 4, human: 2 }, { ai: 2, human: 3 }, { ai: 5, human: 5 }])).toEqual({ n: 4, within1: 0.75, mad: 0.75 });
    expect(driftAgreement([])).toEqual({ n: 0, within1: null, mad: null });
  });

  it("hash32 is FNV-1a", () => {
    expect(hash32("")).toBe(0x811c9dc5);
    expect(hash32("a")).toBe(0xe40c292c);
  });
});
