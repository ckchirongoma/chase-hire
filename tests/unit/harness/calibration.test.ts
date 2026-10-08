import { describe, expect, it } from "vitest";
import { calibrate, FAULTS_BY_CHECK } from "@/lib/harness/calibration";
import { CHECK_KEYS, type CheckKey } from "@/lib/harness/checks";

const all = (passed: boolean | null, except: Partial<Record<CheckKey, boolean | null>> = {}) => CHECK_KEYS.map((key) => ({ key, passed: key in except ? except[key]! : passed }));

describe("harness calibration (docs/07 step 4)", () => {
  it("maps every planted fault but F06 (human-judged) to at least one check, as docs/16 does", () => {
    const covered = new Set(Object.values(FAULTS_BY_CHECK).flat());
    const faults = Array.from({ length: 14 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`);
    expect(faults.filter((f) => !covered.has(f))).toEqual(["F06"]);
    expect(FAULTS_BY_CHECK.R3).toEqual(["F07", "F01"]);
    expect(FAULTS_BY_CHECK.U3).toEqual(["F01", "F03"]);
  });

  it("the reference agrees when everything passes, R6 and U8 being inconclusive locally", () => {
    const v = calibrate("reference", all(true, { R6: null, U8: null }));
    expect(v.mismatches).toEqual([]);
    expect(v.notRun).toEqual([]);
  });

  it("flags a reference check that fails or is inconclusive without a local reason", () => {
    const v = calibrate("reference", all(true, { U5: false, U3: null }));
    expect(v.mismatches.map((m) => m.key)).toEqual(["U3", "U5"]);
  });

  it("the starter agrees when every fault-mapped check fails, whatever the others say", () => {
    const mapped = Object.keys(FAULTS_BY_CHECK) as CheckKey[];
    const results = CHECK_KEYS.map((key) => ({ key, passed: mapped.includes(key) ? false : key === "R5" ? false : key === "U8" || key === "R6" ? null : true }));
    expect(calibrate("starter", results).mismatches).toEqual([]);
  });

  it("flags a starter check that passes or cannot conclude where a fault is planted", () => {
    const mapped = Object.keys(FAULTS_BY_CHECK) as CheckKey[];
    const results = CHECK_KEYS.map((key) => ({ key, passed: mapped.includes(key) ? (key === "U2" ? true : key === "U7" ? null : false) : true }));
    const v = calibrate("starter", results);
    expect(v.mismatches.map((m) => `${m.key}: ${m.note}`)).toEqual(["U2: expected fail (F04)", "U7: inconclusive: expected fail"]);
  });

  it("lists checks that did not run instead of counting them as agreement", () => {
    const v = calibrate("starter", [{ key: "U2", passed: false }]);
    expect(v.mismatches).toEqual([]);
    expect(v.notRun).toContain("M1");
    expect(v.notRun).not.toContain("U2");
  });
});
