import { describe, expect, it } from "vitest";
import { RETENTION_MONTHS, addMonthsUtc, isDue, purgeAfter, retentionEntry, retentionMonths, utcDay } from "@/lib/stats/retention";

const base = {
  admin: false,
  openApplication: false,
  appointed: false,
  openReviewRequest: false,
  closedAt: null,
  lastActivity: "2026-01-10T08:00:00Z",
  talentPool: false,
};

describe("retention periods (notice: 6 months, 12 for the talent pool)", () => {
  it("keeps unsuccessful candidates 6 months and talent-pool opt-ins 12", () => {
    expect(RETENTION_MONTHS).toEqual({ standard: 6, talentPool: 12 });
    expect(retentionMonths(false)).toBe(6);
    expect(retentionMonths(true)).toBe(12);
    expect(purgeAfter("2026-03-15T10:00:00Z", false)).toBe("2026-09-15");
    expect(purgeAfter("2026-03-15T10:00:00Z", true)).toBe("2027-03-15");
  });

  it("adds calendar months in UTC and clamps to the month's last day like Postgres", () => {
    expect(addMonthsUtc("2026-08-31T12:00:00Z", 6)).toBe("2027-02-28");
    expect(addMonthsUtc("2027-08-31T12:00:00Z", 6)).toBe("2028-02-29"); // leap year
    expect(addMonthsUtc("2026-12-31T23:59:59Z", 6)).toBe("2027-06-30");
    expect(addMonthsUtc("2026-07-01T00:00:00Z", 12)).toBe("2027-07-01");
    // 23:30 in Johannesburg on 31 March is still 31 March in UTC (21:30Z)
    expect(addMonthsUtc("2026-03-31T23:30:00+02:00", 6)).toBe("2026-09-30");
    // 00:30 in Johannesburg on 1 April is 31 March 22:30Z: UTC decides
    expect(addMonthsUtc("2026-04-01T00:30:00+02:00", 6)).toBe("2026-09-30");
    expect(() => addMonthsUtc("not a date", 6)).toThrow(RangeError);
    expect(() => addMonthsUtc("2026-01-01T00:00:00Z", 1.5)).toThrow(RangeError);
  });

  it("is due once the date arrives (UTC calendar)", () => {
    expect(utcDay(new Date("2026-09-15T00:00:01Z"))).toBe("2026-09-15");
    expect(isDue("2026-09-15", new Date("2026-09-14T23:59:59Z"))).toBe(false);
    expect(isDue("2026-09-15", new Date("2026-09-15T00:00:00Z"))).toBe(true);
    expect(isDue("2026-09-15", new Date("2027-01-01T00:00:00Z"))).toBe(true);
  });
});

describe("who is queued", () => {
  it("counts 6 months from when the application closed", () => {
    expect(retentionEntry({ ...base, closedAt: "2026-02-01T09:00:00Z" })).toEqual({
      purgeAfter: "2026-08-01",
      basisAt: "2026-02-01T09:00:00.000Z",
      basis: "application_closed",
    });
  });

  it("uses 12 months for a talent-pool opt-in", () => {
    expect(retentionEntry({ ...base, closedAt: "2026-02-01T09:00:00Z", talentPool: true })?.purgeAfter).toBe("2027-02-01");
  });

  it("restarts the clock if there was activity after the close (e.g. a new CV)", () => {
    expect(retentionEntry({ ...base, closedAt: "2026-02-01T09:00:00Z", lastActivity: "2026-04-20T09:00:00Z" })?.purgeAfter).toBe("2026-10-20");
  });

  it("counts from the last activity for someone who never applied", () => {
    expect(retentionEntry(base)).toMatchObject({ purgeAfter: "2026-07-10", basis: "no_application" });
  });

  it("never queues admins, open applications, appointed candidates or open review requests", () => {
    expect(retentionEntry({ ...base, admin: true })).toBeNull();
    expect(retentionEntry({ ...base, openApplication: true, closedAt: "2025-01-01T00:00:00Z" })).toBeNull();
    expect(retentionEntry({ ...base, appointed: true })).toBeNull();
    expect(retentionEntry({ ...base, openReviewRequest: true })).toBeNull();
  });
});
