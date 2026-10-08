import { describe, expect, it } from "vitest";
import { assemblePanel, bankQuestions, CONCERN_ANCHORS, concernKey, isConcernKey, normaliseConcerns, PANEL_SIZE, type BankQuestion } from "@/lib/live/panel";

const anchors = { "1": "weak", "3": "ok", "5": "strong" };
const q = (n: number, replaceable = false, extra: Partial<BankQuestion> = {}): BankQuestion => ({
  key: `q${n}`,
  position: n,
  text: `Question ${n}?`,
  probes: [`Probe ${n}`],
  anchors,
  replaceable,
  ...extra,
});
/** Six questions; 5 and 6 are the verification slots, as seeded in migration 0017. */
const BANK = [q(4), q(2), q(6, true), q(1), q(5, true), q(3)];
const C1 = { claim: "Led the Postgres migration", reason: "Could not describe an index" };
const C2 = { claim: "Saved 20 hours a week", reason: "No numbers when probed" };
const C3 = { claim: "Built the data warehouse", reason: "Vague on tools" };
const K1 = concernKey(C1.claim);
const K2 = concernKey(C2.claim);

describe("assemblePanel (docs/09 §5)", () => {
  it("with no concerns: the six bank questions in position order", () => {
    const p = assemblePanel(BANK, []);
    expect(p.map((x) => x.key)).toEqual(["q1", "q2", "q3", "q4", "q5", "q6"]);
    expect(p.every((x) => x.source === "bank")).toBe(true);
  });

  it("with one concern: replaces only the first replaceable slot", () => {
    const p = assemblePanel(BANK, [C1]);
    expect(p.map((x) => x.key)).toEqual(["q1", "q2", "q3", "q4", K1, "q6"]);
    const c = p[4];
    expect(c).toMatchObject({ source: "concern", position: 5, anchors: CONCERN_ANCHORS });
    expect(c.text).toContain(C1.claim);
    expect(c.text).toContain(C1.reason);
    expect(c.probes.length).toBeGreaterThanOrEqual(3);
  });

  it("with two or more concerns: replaces both replaceable slots, in order, and never more than two", () => {
    for (const concerns of [[C1, C2], [C1, C2, C3]]) {
      const p = assemblePanel(BANK, concerns);
      expect(p).toHaveLength(PANEL_SIZE);
      expect(p.map((x) => x.key)).toEqual(["q1", "q2", "q3", "q4", K1, K2]);
      expect(p[4].text).toContain(C1.claim);
      expect(p[5].text).toContain(C2.claim);
      expect(p.filter((x) => x.source === "concern")).toHaveLength(2);
    }
  });

  it("keys a verification question on its claim, not its position, so re-ordered concerns keep their scores", () => {
    expect(K1).toMatch(/^concern_[0-9a-f]{8}$/);
    expect(isConcernKey(K1)).toBe(true);
    expect(isConcernKey("ba_panel_data_problem")).toBe(false);
    expect(K1).not.toBe(K2);
    expect(concernKey("  Led the   POSTGRES migration ")).toBe(K1);
    const swapped = assemblePanel(BANK, [C2, C1]);
    expect(swapped.map((x) => x.key)).toEqual(["q1", "q2", "q3", "q4", K2, K1]);
    expect(swapped[5].text).toContain(C1.claim);
  });

  it("falls back to the last questions when the bank marks no replaceable slots", () => {
    const bank = BANK.map((x) => ({ ...x, replaceable: false }));
    expect(assemblePanel(bank, [C1, C2]).map((x) => x.key)).toEqual(["q1", "q2", "q3", "q4", K1, K2]);
    const one = BANK.map((x) => ({ ...x, replaceable: x.key === "q2" }));
    expect(assemblePanel(one, [C1, C2]).map((x) => x.key)).toEqual(["q1", K1, "q3", "q4", "q5", K2]);
  });

  it("skips inactive questions and caps the card at six", () => {
    const bank = [...BANK, q(7), q(8, false, { active: false })];
    const p = assemblePanel(bank.map((x) => (x.key === "q3" ? { ...x, active: false } : x)), []);
    expect(p.map((x) => x.key)).toEqual(["q1", "q2", "q4", "q5", "q6", "q7"]);
  });

  it("does not mutate the bank", () => {
    const copy = structuredClone(BANK);
    assemblePanel(BANK, [C1, C2]);
    expect(BANK).toEqual(copy);
  });
});

describe("normaliseConcerns", () => {
  it("keeps well-formed concerns, trims, de-duplicates by claim and drops junk", () => {
    const raw = [
      { claim: "  Led the   Postgres migration ", reason: "Could not\ndescribe an index" },
      { claim: "led the postgres migration", reason: "dup" },
      { claim: "", reason: "no claim" },
      { reason: "missing claim" },
      "a string",
      null,
      { claim: "Saved 20 hours", reason: 42 },
    ];
    expect(normaliseConcerns(raw)).toEqual([
      { claim: "Led the Postgres migration", reason: "Could not describe an index" },
      { claim: "Saved 20 hours", reason: "" },
    ]);
  });

  it("returns [] for anything that is not an array", () => {
    expect(normaliseConcerns(undefined)).toEqual([]);
    expect(normaliseConcerns({ claim: "x" })).toEqual([]);
  });

  it("clips very long text", () => {
    const [c] = normaliseConcerns([{ claim: "x".repeat(1000), reason: "y".repeat(1000) }]);
    expect(c.claim.length).toBeLessThanOrEqual(300);
    expect(c.reason.length).toBeLessThanOrEqual(400);
  });
});

describe("bankQuestions", () => {
  it("returns active questions by position", () => {
    expect(bankQuestions([q(3), q(1), q(2, false, { active: false })]).map((x) => x.key)).toEqual(["q1", "q3"]);
  });
});
