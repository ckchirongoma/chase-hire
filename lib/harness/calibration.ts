import { CHECK_KEYS, type CheckKey } from "./checks";

/**
 * Harness calibration (docs/07 "Building the starter", step 4): the reference app must pass every
 * check and the starter must fail every check that maps to a planted fault. Pure, so the rule is
 * unit-tested; scripts/verify-swe1/calibrate.ts runs the checks and applies it.
 */

/** docs/16 "Check → fault map": the planted faults each automated check catches. */
export const FAULTS_BY_CHECK: Partial<Record<CheckKey, readonly string[]>> = {
  R1: ["F13"],
  R2: ["F04"],
  R3: ["F07", "F01"],
  R7: ["F13"],
  U2: ["F04"],
  U3: ["F01", "F03"],
  U4: ["F02"],
  U5: ["F05"],
  U6: ["F10"],
  U7: ["F12"],
  M1: ["F08", "F14"],
  M2: ["F08", "F14"],
  M3: ["F08", "F14"],
  M4: ["F08", "F14"],
  M5: ["F08", "F14"],
  M6: ["F08", "F14"],
  M7: ["F08", "F14"],
  "D-a": ["F09"],
  "D-b": ["F11"],
};

/**
 * Checks that cannot conclude in a local calibration: R6 needs the repo's CI history on GitHub,
 * U8 needs a public host name for the MDN Observatory. Inconclusive there is honest, not a miss.
 */
export const LOCAL_INCONCLUSIVE: readonly CheckKey[] = ["R6", "U8"];

export type CalibrationTarget = "reference" | "starter";

export interface CalibrationRow {
  key: CheckKey;
  /** null: inconclusive or informational; undefined: the check did not run in this calibration. */
  passed: boolean | null | undefined;
  expected: "pass" | "fail" | "any";
  faults: readonly string[];
  ok: boolean;
  note: string;
}

export interface Calibration {
  target: CalibrationTarget;
  rows: CalibrationRow[];
  mismatches: CalibrationRow[];
  notRun: CheckKey[];
}

/**
 * Judges one app's results. Reference: every check passes (inconclusive only for the keys in
 * `allowInconclusive`). Starter: every fault-mapped check fails; the rest are reported, not judged
 * (R4 "looks finished" passes, R5 fails on F09's tests, U1 is healthy, D-c is a symptom of F08/F14).
 * Checks that did not run are listed in `notRun`, never counted as agreement.
 */
export function calibrate(target: CalibrationTarget, results: readonly { key: string; passed: boolean | null }[], allowInconclusive: readonly CheckKey[] = LOCAL_INCONCLUSIVE): Calibration {
  const byKey = new Map(results.map((r) => [r.key, r.passed]));
  const rows: CalibrationRow[] = CHECK_KEYS.map((key) => {
    const faults = FAULTS_BY_CHECK[key] ?? [];
    const passed = byKey.has(key) ? byKey.get(key)! : undefined;
    const expected: CalibrationRow["expected"] = target === "reference" ? "pass" : faults.length ? "fail" : "any";
    if (passed === undefined) return { key, passed, expected, faults, ok: true, note: "not run" };
    if (expected === "any") return { key, passed, expected, faults, ok: true, note: "no planted fault: reported only" };
    if (passed === null) {
      const honest = target === "reference" && allowInconclusive.includes(key);
      return { key, passed, expected, faults, ok: honest, note: honest ? "inconclusive locally (expected)" : `inconclusive: expected ${expected}` };
    }
    const ok = expected === "pass" ? passed : !passed;
    return { key, passed, expected, faults, ok, note: ok ? "as expected" : `expected ${expected}${faults.length ? ` (${faults.join(", ")})` : ""}` };
  });
  return { target, rows, mismatches: rows.filter((r) => !r.ok), notRun: rows.filter((r) => r.passed === undefined).map((r) => r.key) };
}
