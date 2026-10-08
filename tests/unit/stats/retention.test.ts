import { describe, expect, it } from "vitest";
import {
  RETENTION_MONTHS,
  STALE_MONTHS,
  addMonthsUtc,
  addMonthsUtcTs,
  applicationEnd,
  isDue,
  purgeAfter,
  purgeBatch,
  retentionEntry,
  retentionMonths,
  utcDay,
  type ApplicationFacts,
  type RetentionFacts,
} from "@/lib/stats/retention";

const base: RetentionFacts = {
  admin: false,
  appointed: false,
  openReviewRequest: false,
  applications: [],
  lastActivity: "2026-01-10T08:00:00Z",
  talentPool: false,
};
const NOW = new Date("2026-10-08T12:00:00Z");
const closedApp = (closedAt: string, extra: Partial<ApplicationFacts> = {}): ApplicationFacts => ({
  closed: true,
  closedAt,
  roundClosedAt: null,
  activeAt: closedAt,
  ...extra,
});
const openApp = (activeAt: string, extra: Partial<ApplicationFacts> = {}): ApplicationFacts => ({
  closed: false,
  closedAt: null,
  roundClosedAt: null,
  activeAt,
  ...extra,
});

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
    expect(retentionEntry({ ...base, applications: [closedApp("2026-02-01T09:00:00Z")] }, NOW)).toEqual({
      purgeAfter: "2026-08-01",
      basisAt: "2026-02-01T09:00:00.000Z",
      basis: "application_closed",
    });
  });

  it("uses 12 months for a talent-pool opt-in", () => {
    expect(retentionEntry({ ...base, applications: [closedApp("2026-02-01T09:00:00Z")], talentPool: true }, NOW)?.purgeAfter).toBe("2027-02-01");
  });

  it("restarts the clock if there was activity after the close (e.g. a new CV)", () => {
    expect(
      retentionEntry({ ...base, applications: [closedApp("2026-02-01T09:00:00Z")], lastActivity: "2026-04-20T09:00:00Z" }, NOW)?.purgeAfter,
    ).toBe("2026-10-20");
  });

  it("counts from the last activity for someone who never applied", () => {
    expect(retentionEntry(base, NOW)).toMatchObject({ purgeAfter: "2026-07-10", basis: "no_application" });
  });

  it("never queues admins, former staff, open applications, appointed candidates or open review requests", () => {
    expect(retentionEntry({ ...base, admin: true }, NOW)).toBeNull();
    expect(retentionEntry({ ...base, formerStaff: true }, NOW)).toBeNull();
    expect(retentionEntry({ ...base, applications: [closedApp("2025-01-01T00:00:00Z"), openApp("2026-09-01T00:00:00Z")] }, NOW)).toBeNull();
    expect(retentionEntry({ ...base, appointed: true }, NOW)).toBeNull();
    expect(retentionEntry({ ...base, openReviewRequest: true }, NOW)).toBeNull();
  });

  it("uses the latest of several applications", () => {
    const e = retentionEntry({ ...base, applications: [closedApp("2026-03-01T00:00:00Z"), closedApp("2026-01-01T00:00:00Z")] }, NOW);
    expect(e).toMatchObject({ purgeAfter: "2026-09-01", basis: "application_closed" });
  });
});

describe("when an application ends for retention (notice: 6 months after the round closes)", () => {
  it("a closed application ends when it closed, or when its round closed if later", () => {
    expect(applicationEnd(closedApp("2026-02-01T09:00:00Z"), NOW)).toEqual({ at: new Date("2026-02-01T09:00:00Z"), basis: "application_closed" });
    expect(applicationEnd(closedApp("2026-02-01T09:00:00Z", { roundClosedAt: "2026-03-15T00:00:00Z" }), NOW)).toEqual({
      at: new Date("2026-03-15T00:00:00Z"),
      basis: "round_closed",
    });
    // A round that closed before the rejection doesn't move the clock back.
    expect(applicationEnd(closedApp("2026-02-01T09:00:00Z", { roundClosedAt: "2026-01-15T00:00:00Z" }), NOW)?.basis).toBe("application_closed");
  });

  it("an application left in play on a closed round ends at the later of the close and its last activity", () => {
    expect(applicationEnd(openApp("2026-01-10T00:00:00Z", { roundClosedAt: "2026-02-01T00:00:00Z" }), NOW)).toEqual({
      at: new Date("2026-02-01T00:00:00Z"),
      basis: "round_closed",
    });
    expect(applicationEnd(openApp("2026-05-10T00:00:00Z", { roundClosedAt: "2026-02-01T00:00:00Z" }), NOW)?.at).toEqual(new Date("2026-05-10T00:00:00Z"));
  });

  it("an application in play on an open round lapses after 6 months without activity", () => {
    expect(STALE_MONTHS).toBe(6);
    expect(applicationEnd(openApp("2026-05-01T00:00:00Z"), NOW)).toBeNull(); // 5 months idle: still in play
    expect(applicationEnd(openApp("2026-04-08T12:00:00Z"), NOW)).toEqual({ at: new Date("2026-10-08T12:00:00Z"), basis: "inactive" });
    // An abandoned application three years old: purged 6 months after it lapsed.
    const old = retentionEntry({ ...base, lastActivity: "2023-09-01T00:00:00Z", applications: [openApp("2023-09-01T00:00:00Z")] }, NOW);
    expect(old).toEqual({ purgeAfter: "2024-09-01", basisAt: "2024-03-01T00:00:00.000Z", basis: "inactive" });
  });

  it("adds months to timestamps keeping the time of day, clamped like Postgres", () => {
    expect(addMonthsUtcTs("2026-08-31T12:34:56.789Z", 6).toISOString()).toBe("2027-02-28T12:34:56.789Z");
  });
});

describe("purge batches (resumed purges can't starve new ones)", () => {
  const stuck = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ userId: `s${i}`, attempts: 3, startedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
  const due = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`);

  it("gives unfinished purges at most half the run when people are newly due", () => {
    const batch = purgeBatch(stuck(30), due(30), 25);
    expect(batch).toHaveLength(25);
    expect(batch.filter((id) => id.startsWith("s"))).toHaveLength(12);
    expect(batch.filter((id) => id.startsWith("d"))).toHaveLength(13);
  });

  it("lets unfinished purges use the room the newly due don't need, fewest failures first", () => {
    const resuming = [
      { userId: "a", attempts: 5, startedAt: "2026-01-01T00:00:00Z" },
      { userId: "b", attempts: 0, startedAt: "2026-02-01T00:00:00Z" },
      { userId: "c", attempts: 1, startedAt: "2026-01-15T00:00:00Z" },
    ];
    expect(purgeBatch(resuming, ["d0"], 25)).toEqual(["b", "c", "a", "d0"]);
    expect(purgeBatch(resuming, due(3), 4)).toEqual(["b", "c", "d0", "d1"]);
    expect(purgeBatch(resuming, ["d0"], 4)).toEqual(["b", "c", "d0", "a"]);
    expect(purgeBatch(resuming, [], 2)).toEqual(["b", "c"]);
    expect(purgeBatch([], due(3), 2)).toEqual(["d0", "d1"]);
    expect(purgeBatch(resuming, due(3), 0)).toEqual([]);
  });

  it("never lists someone twice", () => {
    expect(purgeBatch([{ userId: "x", attempts: 0, startedAt: "2026-01-01T00:00:00Z" }], ["x", "y"], 5)).toEqual(["x", "y"]);
  });
});
