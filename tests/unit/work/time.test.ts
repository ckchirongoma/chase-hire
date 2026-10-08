import { describe, expect, it } from "vitest";
import { countdown, humanDuration, intervalToMs } from "@/lib/work/time";

describe("intervalToMs", () => {
  it("parses PostgREST interval text", () => {
    expect(intervalToMs("04:00:00")).toBe(4 * 3600_000);
    expect(intervalToMs("48:00:00")).toBe(48 * 3600_000);
    expect(intervalToMs("7 days")).toBe(7 * 86_400_000);
    expect(intervalToMs("1 day 02:30:00")).toBe(86_400_000 + 2.5 * 3600_000);
    expect(intervalToMs("3 hours")).toBe(3 * 3600_000);
    expect(intervalToMs("00:25:00")).toBe(25 * 60_000);
    expect(intervalToMs("PT4H")).toBe(4 * 3600_000);
    expect(intervalToMs("P7D")).toBe(7 * 86_400_000);
  });
  it("returns null for junk", () => {
    expect(intervalToMs(null)).toBeNull();
    expect(intervalToMs("soon")).toBeNull();
    expect(intervalToMs("4 hours and change")).toBeNull();
  });
});

describe("display helpers", () => {
  it("humanDuration", () => {
    expect(humanDuration(4 * 3600_000)).toBe("4 hours");
    expect(humanDuration(72 * 3600_000)).toBe("72 hours");
    expect(humanDuration(7 * 86_400_000)).toBe("7 days");
    expect(humanDuration(60_000)).toBe("1 minute");
  });
  it("countdown", () => {
    expect(countdown(-5)).toBe("0:00");
    expect(countdown(65_000)).toBe("1:05");
    expect(countdown(4 * 3600_000 - 1000)).toBe("3:59:59");
    expect(countdown(72 * 3600_000)).toBe("3d 0h 00m");
  });
});
