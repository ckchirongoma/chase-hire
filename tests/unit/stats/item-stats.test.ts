import { describe, expect, it } from "vitest";
import { ITEM_RULES, TIER_TARGET_P, checkItem } from "@/lib/stats/item-stats";

const item = (tier: string, exposures: number, p: number | string | null, d: number | string | null) => ({
  tier,
  exposures,
  difficulty_p: p,
  discrimination: d,
});

describe("reasoning item checks (docs/04 §4)", () => {
  it("uses the doc's thresholds", () => {
    expect(ITEM_RULES).toEqual({ minExposures: 40, minDiscrimination: 0.15, maxP: 0.9, minP: 0.08 });
    expect(TIER_TARGET_P).toEqual({ easy: [0.65, 0.8], medium: [0.3, 0.5], hard: [0.15, 0.3] });
  });

  it("does not judge items under 40 exposures", () => {
    expect(checkItem(item("medium", 39, 0.95, 0.01))).toMatchObject({ status: "insufficient" });
    expect(checkItem(item("medium", 120, null, null))).toMatchObject({ status: "insufficient" });
  });

  it("marks items for retirement: discrimination < .15, p > .90 or p < .08", () => {
    expect(checkItem(item("medium", 40, 0.4, 0.14)).status).toBe("retire");
    expect(checkItem(item("easy", 40, 0.91, 0.3)).status).toBe("retire");
    expect(checkItem(item("hard", 40, 0.07, 0.3)).status).toBe("retire");
    expect(checkItem(item("medium", 40, 0.4, null)).status).toBe("retire");
    expect(checkItem(item("medium", 40, 0.95, 0.05)).reasons).toHaveLength(2);
  });

  it("flags items outside their tier's target band", () => {
    expect(checkItem(item("easy", 50, 0.6, 0.3))).toMatchObject({ status: "off_target" });
    expect(checkItem(item("medium", 50, 0.55, 0.3))).toMatchObject({ status: "off_target" });
    expect(checkItem(item("hard", 50, 0.35, 0.3))).toMatchObject({ status: "off_target" });
  });

  it("accepts in-band items, including the band edges and PostgREST numeric strings", () => {
    expect(checkItem(item("easy", 50, 0.65, 0.15)).status).toBe("ok");
    expect(checkItem(item("medium", 50, "0.500", "0.310")).status).toBe("ok");
    expect(checkItem(item("hard", 50, 0.15, 0.4)).status).toBe("ok");
  });
});
