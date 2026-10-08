import { describe, expect, it } from "vitest";
import { mapLimit } from "@/lib/grading/concurrency";

describe("mapLimit", () => {
  it("preserves order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n, i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n * 2));
      inFlight--;
      return `${i}:${n}`;
    });
    expect(out).toEqual(["0:5", "1:1", "2:4", "3:2", "4:3"]);
    expect(peak).toBe(2);
    expect(await mapLimit([], 3, async (x) => x)).toEqual([]);
  });
});
