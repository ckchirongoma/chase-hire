import { describe, expect, it } from "vitest";
import {
  assembleLiveForm,
  deltaNeedsDiscussion,
  equatedNorm,
  formCode,
  LIVE_BLUEPRINT,
  LIVE_DELTA_THRESHOLD,
  LIVE_ITEM_COUNT,
  LIVE_NORM,
  liveDelta,
  livePercentile,
  optionLetter,
  seedForApplication,
  stemKey,
} from "@/lib/live/retest";
import { GENERATORS } from "@/lib/reasoning/generators";
import { assembleAttempt } from "@/lib/reasoning/blueprint";
import { PROVISIONAL_NORM, percentileFromNormal } from "@/lib/reasoning/scoring";

const TIER_ORDER = { easy: 0, medium: 1, hard: 2 } as const;

describe("live blueprint (docs/04 §2: 12 items in 6 minutes)", () => {
  it("has 12 items, every family, and the online difficulty mix (2 easy / 7 medium / 3 hard)", () => {
    const rows = Object.values(LIVE_BLUEPRINT);
    expect(rows.reduce((s, r) => s + r.easy + r.medium + r.hard, 0)).toBe(LIVE_ITEM_COUNT);
    expect(rows.every((r) => r.easy + r.medium + r.hard > 0)).toBe(true);
    expect(rows.reduce((s, r) => s + r.easy, 0)).toBe(2);
    expect(rows.reduce((s, r) => s + r.medium, 0)).toBe(7);
    expect(rows.reduce((s, r) => s + r.hard, 0)).toBe(3);
  });
});

describe("assembleLiveForm", () => {
  it("renders 12 items easy → hard, deterministic per seed, each re-generable from its own seed", () => {
    const a = assembleLiveForm(12345);
    expect(a).toHaveLength(12);
    expect(a.map((i) => i.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (let i = 1; i < a.length; i++) expect(TIER_ORDER[a[i].tier]).toBeGreaterThanOrEqual(TIER_ORDER[a[i - 1].tier]);
    expect(assembleLiveForm(12345)).toEqual(a);
    for (const item of a) {
      const again = GENERATORS[item.family](item.seed, item.tier);
      expect(again.stem).toEqual(item.stem);
      expect(again.options).toEqual(item.options);
      expect(again.answerIndex).toBe(item.answerIndex);
      expect(item.options).toHaveLength(5);
    }
    expect(new Set(a.map((i) => stemKey(i.stem))).size).toBe(12);
  });

  it("gives different candidates different forms", () => {
    const a = assembleLiveForm(seedForApplication("11111111-1111-4111-8111-111111111111"));
    const b = assembleLiveForm(seedForApplication("22222222-2222-4222-8222-222222222222"));
    expect(a.map((i) => stemKey(i.stem))).not.toEqual(b.map((i) => stemKey(i.stem)));
  });

  it("never repeats a stem the candidate has already seen", () => {
    const seen = new Set(assembleLiveForm(777).map((i) => stemKey(i.stem)));
    const fresh = assembleLiveForm(777, { exclude: seen });
    expect(fresh).toHaveLength(12);
    expect(fresh.some((i) => seen.has(stemKey(i.stem)))).toBe(false);
    // and works against a whole online attempt
    const online = new Set(assembleAttempt(4242).map((i) => stemKey(i.stem)));
    expect(assembleLiveForm(4242, { exclude: online }).some((i) => online.has(stemKey(i.stem)))).toBe(false);
  });

  it("moves a retired template's items to the nearest active tier of the same family", () => {
    const all = Object.keys(LIVE_BLUEPRINT).flatMap((f) => ["easy", "medium", "hard"].map((t) => `${f}:${t}`));
    const available = new Set(all.filter((k) => k !== "data_interp:hard"));
    const form = assembleLiveForm(99, { available });
    const di = form.filter((i) => i.family === "data_interp");
    expect(di.map((i) => i.tier).sort()).toEqual(["easy", "medium", "medium"]);
    expect(form).toHaveLength(12);
    expect(() => assembleLiveForm(99, { available: new Set(all.filter((k) => !k.startsWith("verbal:"))) })).toThrow(/verbal/);
  });
});

describe("seedForApplication", () => {
  it("is stable, positive and 31-bit", () => {
    const id = "6f1c2a9e-0b7d-4c55-9e1a-2d3f4b5c6d7e";
    expect(seedForApplication(id)).toBe(seedForApplication(id));
    for (const s of ["", "a", id, "zzzz"].map(seedForApplication)) {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(2 ** 31);
    }
  });
});

describe("live norms (docs/04 §6)", () => {
  it("equates the 12-item form to the online applicant-pool norm", () => {
    // Same proportion correct (13.5/30 = .45) and the SD implied by the online inter-item covariance.
    expect(LIVE_NORM).toEqual({ version: "live-provisional-normal-v1", mean: 5.4, sd: 2.374 });
    // Equating a form to itself is the identity.
    expect(equatedNorm(PROVISIONAL_NORM, 30, 30, "x")).toEqual({ version: "x", mean: 13.5, sd: 5 });
  });

  it("raw 0–12 → percentile, monotonic, with known values", () => {
    const p = Array.from({ length: 13 }, (_, r) => livePercentile(r).percentile);
    for (let i = 1; i < p.length; i++) expect(p[i]).toBeGreaterThan(p[i - 1]);
    expect(p[0]).toBe(1.1);
    expect(p[5]).toBe(43.3);
    expect(p[6]).toBe(60);
    expect(p[12]).toBe(99.7);
    expect(livePercentile(7)).toEqual({ percentile: percentileFromNormal(7, 5.4, 2.374), normVersion: "live-provisional-normal-v1" });
  });

  it("rejects raw scores outside 0–12", () => {
    for (const bad of [-1, 13, 2.5, Number.NaN]) expect(() => livePercentile(bad)).toThrow(RangeError);
  });
});

describe("live delta", () => {
  it("is the online percentile minus the live percentile", () => {
    expect(liveDelta(90, 43.3)).toBe(46.7);
    expect(liveDelta(30, 60)).toBe(-30);
    expect(liveDelta(null, 50)).toBeNull();
    expect(liveDelta(undefined, 50)).toBeNull();
  });

  it("flags only a delta above 25 points, for discussion", () => {
    expect(LIVE_DELTA_THRESHOLD).toBe(25);
    expect(deltaNeedsDiscussion(25)).toBe(false);
    expect(deltaNeedsDiscussion(25.1)).toBe(true);
    expect(deltaNeedsDiscussion(-40)).toBe(false);
    expect(deltaNeedsDiscussion(null)).toBe(false);
  });

  it("an online 90th-percentile candidate who scores 5/12 live is flagged; one who scores 9/12 is not", () => {
    expect(deltaNeedsDiscussion(liveDelta(90, livePercentile(5).percentile))).toBe(true);
    expect(deltaNeedsDiscussion(liveDelta(90, livePercentile(9).percentile))).toBe(false);
  });
});

describe("formCode", () => {
  it("is a stable 6-character code that does not reveal the seed", () => {
    expect(formCode(12345)).toBe(formCode(12345));
    expect(formCode(12345)).toMatch(/^[0-9A-Z]{6}$/);
    expect(formCode(12345)).not.toContain("12345");
    expect(formCode(12345)).not.toBe(formCode(12346));
  });
});

describe("optionLetter", () => {
  it("labels options A–E", () => {
    expect([0, 1, 2, 3, 4].map(optionLetter)).toEqual(["A", "B", "C", "D", "E"]);
  });
});
