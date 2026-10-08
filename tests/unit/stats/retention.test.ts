import { describe, expect, it } from "vitest";
import {
  RETENTION_MONTHS,
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
    expect(retentionEntry({ ...base, applications: [closedApp("2026-02-01T09:00:00Z")] })).toEqual({
      purgeAfter: "2026-08-01",
      basisAt: "2026-02-01T09:00:00.000Z",
      basis: "application_closed",
    });
  });

  it("uses 12 months for a talent-pool opt-in", () => {
    expect(retentionEntry({ ...base, applications: [closedApp("2026-02-01T09:00:00Z")], talentPool: true })?.purgeAfter).toBe("2027-02-01");
  });

  it("restarts the clock if there was activity after the close (e.g. a new CV)", () => {
    expect(
      retentionEntry({ ...base, applications: [closedApp("2026-02-01T09:00:00Z")], lastActivity: "2026-04-20T09:00:00Z" })?.purgeAfter,
    ).toBe("2026-10-20");
  });

  it("counts from the last activity for someone who never applied", () => {
    expect(retentionEntry(base)).toMatchObject({ purgeAfter: "2026-07-10", basis: "no_application" });
  });

  it("never queues admins, former staff, open applications, appointed candidates or open review requests", () => {
    expect(retentionEntry({ ...base, admin: true })).toBeNull();
    expect(retentionEntry({ ...base, formerStaff: true })).toBeNull();
    expect(retentionEntry({ ...base, applications: [closedApp("2025-01-01T00:00:00Z"), openApp("2026-09-01T00:00:00Z")] })).toBeNull();
    expect(retentionEntry({ ...base, appointed: true })).toBeNull();
    expect(retentionEntry({ ...base, openReviewRequest: true })).toBeNull();
  });

  it("uses the latest of several applications", () => {
    const e = retentionEntry({ ...base, applications: [closedApp("2026-03-01T00:00:00Z"), closedApp("2026-01-01T00:00:00Z")] });
    expect(e).toMatchObject({ purgeAfter: "2026-09-01", basis: "application_closed" });
  });
});

describe("when an application ends for retention (notice: 6 months after the round closes)", () => {
  it("a closed application ends when it closed, or when its round closed if later", () => {
    expect(applicationEnd(closedApp("2026-02-01T09:00:00Z"))).toEqual({ at: new Date("2026-02-01T09:00:00Z"), basis: "application_closed" });
    expect(applicationEnd(closedApp("2026-02-01T09:00:00Z", { roundClosedAt: "2026-03-15T00:00:00Z" }))).toEqual({
      at: new Date("2026-03-15T00:00:00Z"),
      basis: "round_closed",
    });
    // A round that closed before the rejection doesn't move the clock back.
    expect(applicationEnd(closedApp("2026-02-01T09:00:00Z", { roundClosedAt: "2026-01-15T00:00:00Z" }))?.basis).toBe("application_closed");
  });

  it("an application still in play never starts the clock, however idle and whatever its round", () => {
    // Idle for years on an open round.
    expect(applicationEnd(openApp("2023-09-01T00:00:00Z"))).toBeNull();
    // Mid-pipeline (e.g. an accepted offer never advanced to closed) when the role was made inactive.
    expect(applicationEnd(openApp("2026-01-10T00:00:00Z", { roundClosedAt: "2026-02-01T00:00:00Z" }))).toBeNull();
    const idle = retentionEntry({ ...base, lastActivity: "2023-09-01T00:00:00Z", applications: [openApp("2023-09-01T00:00:00Z")] });
    expect(idle).toBeNull();
    const roundClosed = retentionEntry({
      ...base,
      lastActivity: "2025-01-01T00:00:00Z",
      applications: [closedApp("2025-01-01T00:00:00Z"), openApp("2025-02-01T00:00:00Z", { roundClosedAt: "2025-03-01T00:00:00Z" })],
    });
    expect(roundClosed).toBeNull();
  });

  it("an idle application an admin closed as lapsed counts from the lapse", () => {
    const lapsed = closedApp("2026-03-20T10:00:00Z", { activeAt: "2025-11-02T00:00:00Z" });
    expect(retentionEntry({ ...base, lastActivity: "2025-11-02T00:00:00Z", applications: [lapsed] })).toEqual({
      purgeAfter: "2026-09-20",
      basisAt: "2026-03-20T10:00:00.000Z",
      basis: "application_closed",
    });
  });

  it("an old closed row without a close time falls back to its last activity", () => {
    expect(applicationEnd({ closed: true, closedAt: null, roundClosedAt: null, activeAt: "2026-01-05T00:00:00Z" })).toEqual({
      at: new Date("2026-01-05T00:00:00Z"),
      basis: "application_closed",
    });
  });

  it("adds months to timestamps keeping the time of day, clamped like Postgres", () => {
    expect(addMonthsUtcTs("2026-08-31T12:34:56.789Z", 6).toISOString()).toBe("2027-02-28T12:34:56.789Z");
  });
});

describe("purge batches (time-bounded runs: resumed purges can't starve new ones)", () => {
  const stuck = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ userId: `s${i}`, attempts: 3, startedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
  const due = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`);

  it("alternates unfinished purges with the newly due, so a run cut short by its deadline has done both", () => {
    const batch = purgeBatch(stuck(30), due(30), 1000);
    expect(batch).toHaveLength(60);
    expect(batch.slice(0, 6)).toEqual(["s0", "d0", "s1", "d1", "s2", "d2"]);
    // Wherever the deadline stops the run, unfinished purges have had at most half (rounded up).
    for (let k = 1; k <= batch.length; k++) {
      expect(batch.slice(0, k).filter((id) => id.startsWith("s")).length).toBeLessThanOrEqual(Math.ceil(k / 2));
    }
  });

  it("a large backlog is not held back by a small count: the deadline decides", () => {
    expect(purgeBatch([], due(400), 1000)).toHaveLength(400);
  });

  it("orders unfinished purges by fewest failures and gives either side the room the other doesn't need", () => {
    const resuming = [
      { userId: "a", attempts: 5, startedAt: "2026-01-01T00:00:00Z" },
      { userId: "b", attempts: 0, startedAt: "2026-02-01T00:00:00Z" },
      { userId: "c", attempts: 1, startedAt: "2026-01-15T00:00:00Z" },
    ];
    expect(purgeBatch(resuming, ["d0"], 25)).toEqual(["b", "d0", "c", "a"]);
    expect(purgeBatch(resuming, due(3), 4)).toEqual(["b", "d0", "c", "d1"]);
    expect(purgeBatch(resuming, [], 2)).toEqual(["b", "c"]);
    expect(purgeBatch([], due(3), 2)).toEqual(["d0", "d1"]);
    expect(purgeBatch(resuming, due(3), 0)).toEqual([]);
  });

  it("never lists someone twice", () => {
    expect(purgeBatch([{ userId: "x", attempts: 0, startedAt: "2026-01-01T00:00:00Z" }], ["x", "y", "y"], 5)).toEqual(["x", "y"]);
  });
});
