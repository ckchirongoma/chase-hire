import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIVE_ITEM_COUNT, LIVE_NORM, livePercentile } from "@/lib/live/retest";

/**
 * The database derives a recorded retest's live percentile from the raw score
 * (public.live_retest_percentile, migration 0019). Its table must be the TypeScript live norm.
 */
const SQL = readFileSync(join(__dirname, "../../../supabase/migrations/20261007000019_live_calibration_fixes.sql"), "utf8");

describe("live_retest_percentile (SQL) matches lib/live/retest", () => {
  it("has the same 13 percentiles for raw 0..12 and the same norm version", () => {
    const fn = SQL.slice(SQL.indexOf("function public.live_retest_percentile"));
    const m = fn.match(/array\[([^\]]+)\]::numeric\[\]/);
    expect(m).not.toBeNull();
    const table = m![1].split(",").map((x) => Number(x.trim()));
    expect(table).toEqual(Array.from({ length: LIVE_ITEM_COUNT + 1 }, (_, raw) => livePercentile(raw).percentile));
    expect(SQL).toContain(`'norm_version', '${LIVE_NORM.version}'`);
  });
});
