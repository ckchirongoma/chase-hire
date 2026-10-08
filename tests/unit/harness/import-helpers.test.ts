import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { fail, inconclusive, pass } from "@/lib/harness/checks";
import { optoutEntriesFromSheet } from "@/lib/harness/expected";
import { looksAsync, looseE164, mergeDataChecks, zaVariants } from "@/lib/harness/import-checks";
import { templatesFromPage } from "@/lib/harness/url-checks";
import { readFirstSheet, unzip } from "@/lib/harness/xlsx-lite";
import { fixtureExpected } from "../../harness-fixtures/fake-target";

describe("phone spellings (M3/M4 look lines up however they are stored)", () => {
  it("lists the spellings of a South African number and reads them back", () => {
    expect(zaVariants("+27821000001")).toEqual(["+27821000001", "27821000001", "0821000001", "821000001"]);
    expect(zaVariants("+447700900123")).toEqual(["+447700900123"]);
    for (const v of ["+27821000001", "27821000001", "0821000001", 821000001, "082 100 0001"]) expect(looseE164(v)).toBe("+27821000001");
    expect(looseE164(null)).toBeNull();
  });
});

describe("background imports", () => {
  it("recognises an upload that answers before the import finishes", () => {
    expect(looksAsync({ status: 202, body: "" })).toBe(true);
    expect(looksAsync({ status: 200, body: '{"message":"Import started. Refresh the queue in a minute."}' })).toBe(true);
    expect(looksAsync({ status: 200, body: '{"counts":{"customers_new":15}}' })).toBe(false);
  });
});

describe("D-a..D-c before and after the month-2 import", () => {
  it("fails when either moment fails, and says when", () => {
    const before = [pass("D-a", "ok"), fail("D-b", "46 stale"), inconclusive("D-c", "no dates")];
    const after = [fail("D-a", "numbers"), pass("D-b", "ok"), pass("D-c", "no epoch")];
    const m = mergeDataChecks(before, after);
    expect(m.map((r) => [r.key, r.passed])).toEqual([
      ["D-a", false],
      ["D-b", false],
      ["D-c", true],
    ]);
    expect(m[0].detail.summary).toBe("After the month-2 import: numbers");
    expect(m[1].detail.summary).toBe("As deployed: 46 stale");
    expect(m[2].detail.evidence).toHaveProperty("before_import");
  });

  it("uses the deployed state alone when month 2 was not imported in this run", () => {
    const m = mergeDataChecks([pass("D-a", "ok"), inconclusive("D-b", "no columns")], null);
    expect(m[0]).toMatchObject({ passed: true, detail: { summary: "ok (as deployed)" } });
    expect(m[1]).toMatchObject({ passed: null, detail: { inconclusive: true, reason: "no columns" } });
  });
});

describe("U7: message templates on a customer page", () => {
  it("reads a React-rendered template picker, utility first", () => {
    const html = `<select class="input"><option value="t-mkt">Upgrade offer<!-- --> (<!-- -->marketing<!-- -->)</option><option value="t-util">Reminder<!-- --> (<!-- -->utility<!-- -->)</option></select><select name="segment"><option value="SME">SME</option></select>`;
    expect(templatesFromPage(html)).toEqual([
      { id: "t-util", category: "utility" },
      { id: "t-mkt", category: "marketing" },
    ]);
  });

  it("reads the server-rendered props even when the form is hidden, with braces in the bodies", () => {
    const props = JSON.stringify({ templates: [{ id: "a1", name: "Promo", category: "marketing", body: "Hi {{name}}, {see}" }, { id: "b2", name: "Reminder", category: "utility", body: "Ends {{date}}" }] }).replace(/"/g, '\\"');
    const html = `<p class="notice">No consented contact.</p><script>self.__next_f.push([1,"5:[\\"$\\",\\"$L6\\",null,${props}]"])</script>`;
    expect(templatesFromPage(html)).toEqual([
      { id: "b2", category: "utility" },
      { id: "a1", category: "marketing" },
    ]);
    expect(templatesFromPage("<p>nothing</p>")).toEqual([]);
  });
});

describe("xlsx-lite and the candidate's opt-out sheet", () => {
  it("reads the first sheet of a workbook (shared strings, numbers, gaps) and the opt-out entries", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Opt-outs");
    ws.addRow(["Company", "Date Logged", "Status", "Notes"]);
    ws.addRow(["Marula Motors", new Date(Date.UTC(2026, 8, 1)), "Opted out", "Complaint & SMS"]);
    ws.addRow(["Somebody Else <Pty> Ltd", 45000, "Under legal review"]);
    ws.addRow([]);
    ws.addRow(["", 1, "x"]);
    wb.addWorksheet("Second").addRow(["not read"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    expect([...unzip(buf).keys()]).toContain("xl/workbook.xml");
    const rows = readFirstSheet(buf);
    expect(rows[0]).toEqual(["Company", "Date Logged", "Status", "Notes"]);
    expect(rows[1][0]).toBe("Marula Motors");
    expect(rows[1][3]).toBe("Complaint & SMS");
    expect(rows[2]).toEqual(["Somebody Else <Pty> Ltd", "45000", "Under legal review"]);

    const entries = optoutEntriesFromSheet(rows, fixtureExpected())!;
    expect(entries).toEqual([
      { listedName: "Marula Motors", normalised: "MARULA MOTORS", status: "Opted out", regNo: "2016/100002/23", accountNos: [2002] },
      { listedName: "Somebody Else <Pty> Ltd", normalised: expect.any(String), status: "Under legal review", regNo: null, accountNos: [] },
    ]);
    expect(optoutEntriesFromSheet([["Date", "Notes"]], null)).toBeNull();
  });

  it("refuses something that is not a zip", () => {
    expect(() => readFirstSheet(Buffer.from("not a workbook"))).toThrow(/not a zip/);
  });
});
