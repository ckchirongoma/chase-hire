import { describe, expect, it } from "vitest";
import { deriveContractStatus, normaliseCompanyName, normalisePhone, parseDate } from "@/lib/import/normalise";

describe("phone numbers become E.164 text", () => {
  it.each([
    [821234567, "+27821234567"],
    [27821234567, "+27821234567"],
    ["082 123 4567", "+27821234567"],
    ["(082) 1234567", "+27821234567"],
    ["+27 82 123 4567", "+27821234567"],
    ["27 82 123 4567", "+27821234567"],
    ["082.123.4567", "+27821234567"],
    ["(082)123-4567", "+27821234567"],
    ["0821234567 ", "+27821234567"],
  ])("%s → %s (mobile)", (input, e164) => {
    expect(normalisePhone(input)).toEqual({ ok: true, e164, type: "mobile" });
  });

  it("keeps the number as text, never as a number (no lost leading zero)", () => {
    const r = normalisePhone(712345678);
    expect(r.ok && typeof r.e164).toBe("string");
  });

  it("marks landlines so they are never sent SMS or WhatsApp", () => {
    expect(normalisePhone(112345678)).toEqual({ ok: true, e164: "+27112345678", type: "landline" });
    expect(normalisePhone("(021) 4567890")).toEqual({ ok: true, e164: "+27214567890", type: "landline" });
  });

  it("rejects placeholders and junk", () => {
    expect(normalisePhone(0).ok).toBe(false);
    expect(normalisePhone(null).ok).toBe(false);
    expect(normalisePhone("12345").ok).toBe(false);
    expect(normalisePhone("+44 20 7946 0000").ok).toBe(false);
  });
});

describe("dates", () => {
  it("trusts real Excel dates and ISO text", () => {
    expect(parseDate(new Date(Date.UTC(2027, 1, 28)))).toEqual({ ok: true, date: "2027-02-28" });
    expect(parseDate("2027-02-28")).toEqual({ ok: true, date: "2027-02-28" });
    expect(parseDate(46000)).toEqual({ ok: true, date: "2025-12-09" });
  });

  it("reads slash dates only when one part is over 12", () => {
    expect(parseDate("11/23/2026")).toEqual({ ok: true, date: "2026-11-23" });
    expect(parseDate("23/11/2026")).toEqual({ ok: true, date: "2026-11-23" });
    expect(parseDate("2026/13/08")).toEqual({ ok: true, date: "2026-08-13" });
  });

  it("reports ambiguous dates instead of guessing", () => {
    const r = parseDate("05/11/2027");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("ambiguous_date");
  });

  it("reports 1970 placeholders and impossible dates", () => {
    expect(parseDate(new Date(Date.UTC(1970, 0, 1)))).toMatchObject({ ok: false, reason: "epoch_date" });
    expect(parseDate("2026-02-30")).toMatchObject({ ok: false, reason: "invalid_date" });
    expect(parseDate("31/31/2026")).toMatchObject({ ok: false, reason: "invalid_date" });
  });

  it("treats a blank cell as no date", () => {
    expect(parseDate(null)).toEqual({ ok: true, date: null });
  });
});

describe("contract status comes from the end date", () => {
  it("derives InContract / Out Of Contract / Unknown", () => {
    expect(deriveContractStatus("2026-10-08", "2026-10-08")).toBe("InContract");
    expect(deriveContractStatus("2026-10-07", "2026-10-08")).toBe("Out Of Contract");
    expect(deriveContractStatus(null, "2026-10-08")).toBe("Unknown");
  });
});

describe("company names", () => {
  it("normalises legal suffixes, case, punctuation and spacing to one key", () => {
    const key = "MOKOENA AND DLAMINI LOGISTICS";
    for (const v of ["MOKOENA & DLAMINI LOGISTICS (PTY) LTD", "Mokoena & Dlamini Logistics (Pty) Ltd", "Mokoena and Dlamini Logistics Pty Ltd", "MOKOENA  &  DLAMINI LOGISTICS (PTY)LTD", "Mokoena & Dlamini Logistics."]) {
      expect(normaliseCompanyName(v)).toBe(key);
    }
    expect(normaliseCompanyName("UBUNTU TRADING CC")).toBe("UBUNTU TRADING");
    expect(normaliseCompanyName("Ubuntu Trading C.C.")).toBe("UBUNTU TRADING");
  });
});
