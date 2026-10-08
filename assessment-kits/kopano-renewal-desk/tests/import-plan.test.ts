import { describe, expect, it } from "vitest";
import { planBaseImport } from "@/lib/import/base";
import { ImportStructureError } from "@/lib/import/columns";
import { readWorkbook } from "@/lib/import/xlsx";
import { BASE_HEADERS, baseRow, workbook } from "./helpers/db";

async function plan(rows: ReturnType<typeof baseRow>[], headers = BASE_HEADERS) {
  const [sheet] = await readWorkbook(await workbook(rows, headers));
  return planBaseImport(sheet);
}

describe("monthly import: planning a file (no database)", () => {
  it("fails loudly naming the column when the export's structure changes, before anything is written", async () => {
    const drifted = BASE_HEADERS.map((h) => (h === "Contract End Date" ? "Contract_End" : h)).concat("Sales_Rep");
    const err = await plan([baseRow({})], drifted).catch((e) => e);
    expect(err).toBeInstanceOf(ImportStructureError);
    expect(err.message).toContain('"Contract End Date" is missing');
    expect(err.message).toContain('renamed to "Contract_End"');
    expect(err.message).toContain('"Sales_Rep"');
    expect(err.missing).toEqual(["Contract End Date"]);
  });

  it("stores phones as E.164 text, flags landlines and quarantines unusable numbers", async () => {
    const p = await plan([
      baseRow({ Msisdn: 821000001 }),
      baseRow({ Msisdn: "(011) 2345678" }),
      baseRow({ Msisdn: 0 }),
    ]);
    expect(p.lines.map((l) => [l.msisdn_e164, l.number_type])).toEqual([
      ["+27821000001", "mobile"],
      ["+27112345678", "landline"],
    ]);
    expect(p.quarantine).toEqual([expect.objectContaining({ row_number: 4, reason: "invalid_phone" })]);
    // The account is still known even though one of its lines is not usable.
    expect(p.accounts).toHaveLength(1);
  });

  it("counts exact duplicate rows once and quarantines conflicting ones", async () => {
    const p = await plan([baseRow({}), baseRow({}), baseRow({ Priceplan: "BZT600" })]);
    expect(p.lines).toHaveLength(1);
    expect(p.stats.duplicate_rows).toBe(1);
    expect(p.quarantine.map((q) => q.reason)).toEqual(["conflicting_duplicate"]);
  });

  it("quarantines ambiguous and epoch dates with reasons but keeps the line (its end date is not trusted)", async () => {
    const p = await plan([
      baseRow({ Msisdn: 821000001, "Contract End Date": "05/11/2027" }),
      baseRow({ Msisdn: 821000002, "Contract End Date": new Date(Date.UTC(1970, 0, 1)) }),
      baseRow({ Msisdn: 821000003, "Contract End Date": "11/23/2026" }),
    ]);
    expect(p.quarantine.map((q) => [q.row_number, q.reason])).toEqual([
      [2, "ambiguous_date"],
      [3, "epoch_date"],
    ]);
    expect(p.lines.map((l) => [l.contract_end_date, l.end_date_trusted])).toEqual([
      [null, false],
      [null, false],
      ["2026-11-23", true],
    ]);
    expect(p.seen).toHaveLength(3);
  });

  it("is deterministic: planning the same file twice gives the same plan (safe to re-run)", async () => {
    const rows = [baseRow({}), baseRow({ Msisdn: 832000002, "Account No": 10000002, "Reg No": null, "Customer Name": "Test Trading (Pty) Ltd" })];
    const [a, b] = [await plan(rows), await plan(rows)];
    expect(b).toEqual(a);
    expect(a.accounts.map((x) => x.normalised_name)).toEqual(["TEST TRADING", "TEST TRADING"]);
  });

  it("reports the export's stale status instead of using it", async () => {
    const p = await plan([baseRow({ "Contract End Date": new Date(Date.UTC(2020, 0, 1)), "Contract Status": "InContract" })]);
    expect(p.stats.stale_export_status_rows).toBe(1);
    expect(p.lines[0].contract_end_date).toBe("2020-01-01");
  });
});
