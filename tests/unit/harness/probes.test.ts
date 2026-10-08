import { describe, expect, it } from "vitest";
import { matchOptouts, optoutEntries } from "@/lib/harness/expected";
import { quarantineFromResponse, quarantineRecall } from "@/lib/harness/import-checks";
import { authCookieName, inList, sessionCookieHeader } from "@/lib/harness/supabase";
import { healthReportsDb } from "@/lib/harness/url-checks";
import { fixtureExpected } from "../../harness-fixtures/fake-target";

describe("U1: does /api/health report the database?", () => {
  it.each([
    [{ ok: true, db: "ok" }, true],
    [{ status: "ok", database: "connected" }, true],
    [{ checks: { db: { status: "up" } } }, true],
    [{ ok: true, supabase: true }, true],
    [{ ok: true, db: "error: timeout" }, false],
    [{ ok: true }, false],
    [null, false],
  ])("%j → %s", (body, expected) => {
    expect(healthReportsDb(body).reports).toBe(expected);
  });
});

describe("M5: quarantine report", () => {
  const expected = [
    { row: 6, reason: "ambiguous_date" },
    { row: 16, reason: "invalid_phone" },
  ];
  it("matches Excel row numbers, or 0/1-based data indices", () => {
    expect(quarantineRecall([{ row: 6, reason: "a" }, { row: 16, reason: "b" }], expected)).toMatchObject({ recall: 1, offset: 0 });
    expect(quarantineRecall([{ row: 4, reason: "a" }, { row: 14, reason: "b" }], expected)).toMatchObject({ recall: 1, offset: -2 });
    expect(quarantineRecall([{ row: 6, reason: "" }], expected)).toMatchObject({ recall: 0.5, withoutReason: 1, missing: [16] });
  });
  it("reads a quarantine list out of an import response", () => {
    expect(quarantineFromResponse({ counts: { inserted: 3 }, quarantine: [{ row_number: 6, reason: "ambiguous date" }, { rowNumber: 16, reasons: ["bad phone", "x"] }] })).toEqual([
      { row: 6, reason: "ambiguous date" },
      { row: 16, reason: "bad phone; x" },
    ]);
  });
});

describe("U7: opt-out matching", () => {
  it("matches by reg no, then by normalised name variants", () => {
    const entries = optoutEntries(fixtureExpected());
    expect(entries[0]).toMatchObject({ listedName: "Marula Motors", normalised: "MARULA MOTORS" });
    const m = matchOptouts(
      [
        { id: "1", reg_no: "2016/100002/23", legal_name: "Something else" },
        { id: "2", reg_no: null, legal_name: "MARULA MOTORS CC" },
        { id: "3", reg_no: null, legal_name: "Marula Motors (Pty) Ltd." },
        { id: "4", reg_no: "1999/000001/07", legal_name: "Kudu Engineering" },
      ],
      entries,
    );
    expect(m.map((x) => [x.customer.id, x.via])).toEqual([
      ["1", "reg_no"],
      ["2", "name"],
      ["3", "name"],
    ]);
  });
});

describe("Supabase helpers", () => {
  it("quotes PostgREST in-lists", () => {
    expect(inList(["+27821000001", 'a"b', "x,y"])).toBe('in.("+27821000001","a\\"b","x,y")');
  });
  it("builds the @supabase/ssr cookie, chunked above 3180 characters", () => {
    const url = "https://abcdefghijklmnopqrst.supabase.co";
    expect(authCookieName(url)).toBe("sb-abcdefghijklmnopqrst-auth-token");
    const small = sessionCookieHeader(url, { accessToken: "t", userId: "u", email: "e", raw: { access_token: "t" } });
    expect(small).toMatch(/^sb-abcdefghijklmnopqrst-auth-token=base64-/);
    const big = sessionCookieHeader(url, { accessToken: "t", userId: "u", email: "e", raw: { access_token: "t", pad: "x".repeat(5000) } });
    const parts = big.split("; ");
    expect(parts.map((p) => p.split("=")[0])).toEqual(["sb-abcdefghijklmnopqrst-auth-token.0", "sb-abcdefghijklmnopqrst-auth-token.1", "sb-abcdefghijklmnopqrst-auth-token.2"]);
    const joined = parts.map((p) => p.slice(p.indexOf("=") + 1)).join("");
    expect(JSON.parse(Buffer.from(joined.slice(7), "base64url").toString()).pad).toHaveLength(5000);
  });
});
