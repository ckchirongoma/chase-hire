import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importBaseFile } from "@/lib/import/base";
import { ImportStructureError } from "@/lib/import/columns";
import { DB_TESTS, BASE_HEADERS, adminClient, allocate, baseRow, customerIdByAccount, makeUser, resetDatabase, workbook, type TestUser } from "./helpers/db";

/**
 * The monthly import against a real database: idempotent re-runs, history surviving month to
 * month, ported lines kept, quarantine stored, and loud failure with no partial writes.
 */

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

// Month 1: two customers (one with two accounts, one blank reg no), a landline and an unusable number.
const month1 = () => [
  baseRow({ "Account No": 30000001, "Reg No": "2005/111111/07", "Customer Name": "NKOSI TYRES (PTY) LTD", Msisdn: 821000001, "Contract End Date": d(2026, 12, 1) }),
  baseRow({ "Account No": 30000001, "Reg No": "2005/111111/07", "Customer Name": "NKOSI TYRES (PTY) LTD", Msisdn: 821000002, "Contract End Date": d(2027, 3, 1) }),
  baseRow({ "Account No": 30000002, "Reg No": null, "Customer Name": "NKOSI TYRES (PTY)LTD", Msisdn: "(011) 2223333", "Contract End Date": d(2027, 5, 1) }),
  baseRow({ "Account No": 30000003, "Reg No": "2012/222222/23", "Customer Name": "KAROO BAKERY CC", Msisdn: 831000001, "Contract End Date": d(2026, 11, 20) }),
  baseRow({ "Account No": 30000003, "Reg No": "2012/222222/23", "Customer Name": "KAROO BAKERY CC", Msisdn: 831000002, "Contract End Date": d(2027, 8, 1) }),
  baseRow({ "Account No": 30000003, "Reg No": "2012/222222/23", "Customer Name": "KAROO BAKERY CC", Msisdn: 0 }),
];

async function counts() {
  const admin = adminClient();
  const [c, a, l, active] = await Promise.all([
    admin.from("customers").select("id", { count: "exact", head: true }),
    admin.from("accounts").select("id", { count: "exact", head: true }),
    admin.from("lines").select("id", { count: "exact", head: true }),
    admin.from("lines").select("id", { count: "exact", head: true }).eq("active", true),
  ]);
  return { customers: c.count, accounts: a.count, lines: l.count, active: active.count };
}

async function lineByNumber(e164: string) {
  const { data } = await adminClient().from("lines").select("*").eq("msisdn_e164", e164).single();
  return data;
}

describe.skipIf(!DB_TESTS)("monthly import (database)", () => {
  let manager: TestUser;
  let agent: TestUser;

  beforeAll(async () => {
    await resetDatabase();
    manager = await makeUser("manager", "import-mgr");
    agent = await makeUser("agent", "import-agent");
  });

  afterAll(resetDatabase);

  it("month 1: one customer per company, E.164 text, landlines marked, unusable rows quarantined", async () => {
    const r = await importBaseFile(manager.db, "month1.xlsx", await workbook(month1()));
    expect(await counts()).toEqual({ customers: 2, accounts: 3, lines: 5, active: 5 });
    expect(r.counts).toMatchObject({ customers_new: 2, accounts_new: 3, lines_new: 5, quarantined: 1 });
    expect((await lineByNumber("+27112223333"))?.number_type).toBe("landline");
    expect(await customerIdByAccount("30000002")).toBe(await customerIdByAccount("30000001"));
  });

  it("re-importing the same file changes nothing (idempotent upsert)", async () => {
    const before = await adminClient().from("lines").select("id, msisdn_e164, updated_at").order("msisdn_e164");
    const r = await importBaseFile(manager.db, "month1.xlsx", await workbook(month1()));
    expect(r.counts).toMatchObject({ customers_new: 0, accounts_new: 0, lines_new: 0, lines_updated: 0, lines_ported_out: 0 });
    const after = await adminClient().from("lines").select("id, msisdn_e164, updated_at").order("msisdn_e164");
    expect(after.data).toEqual(before.data);
  });

  it("month 2: history survives, changes update in place, removed lines are kept as ported, new lines and customers are added", async () => {
    const nkosi = await customerIdByAccount("30000001");
    await allocate(nkosi, agent.id);
    const { error } = await agent.db.from("interactions").insert({ customer_id: nkosi, agent_id: agent.id, outcome: "quote", notes: "Wants 3 new devices" });
    expect(error).toBeNull();
    const before = await lineByNumber("+27821000002");

    const m2 = month1()
      .filter((r) => r[3] !== 831000002) // ported out
      .map((r) => (r[3] === 821000002 ? baseRow({ "Account No": 30000001, "Reg No": "2005/111111/07", "Customer Name": "NKOSI TYRES (PTY) LTD", Msisdn: "+27 82 100 0002", Priceplan: "BZT600", "Contract End Date": d(2027, 3, 1) }) : r));
    m2.push(baseRow({ "Account No": 30000001, "Reg No": "2005/111111/07", "Customer Name": "NKOSI TYRES (PTY) LTD", Msisdn: 821000009 })); // new line, existing customer
    m2.push(baseRow({ "Account No": 30000009, "Reg No": "2019/333333/07", "Customer Name": "VUKANI SECURITY (PTY) LTD", Msisdn: 841000001 })); // new customer
    m2.push(baseRow({ "Account No": 30000003, "Reg No": "2012/222222/23", "Customer Name": "KAROO BAKERY CC", Msisdn: 831000001, "Contract End Date": "05/11/2027" })); // conflicting duplicate with an ambiguous date
    m2.push(m2[0]); // exact duplicate row

    const r = await importBaseFile(manager.db, "month2.xlsx", await workbook(m2));
    expect(r.counts).toMatchObject({ customers_new: 1, lines_new: 2, lines_updated: 1, lines_ported_out: 1, duplicate_rows: 1 });
    expect(await counts()).toEqual({ customers: 3, accounts: 4, lines: 7, active: 6 });

    // Same customer id, same interaction history.
    expect(await customerIdByAccount("30000001")).toBe(nkosi);
    const { data: history } = await adminClient().from("interactions").select("customer_id, notes").eq("customer_id", nkosi);
    expect(history).toEqual([{ customer_id: nkosi, notes: "Wants 3 new devices" }]);

    // Changed line updated in place (same id), not duplicated.
    const changed = await lineByNumber("+27821000002");
    expect(changed).toMatchObject({ id: before!.id, priceplan: "BZT600" });

    // Removed line kept, marked ported out.
    const ported = await lineByNumber("+27831000002");
    expect(ported).toMatchObject({ active: false });
    expect(ported!.ported_out_at).not.toBeNull();

    // The quarantine report is stored with reasons.
    const { data: q } = await adminClient().from("quarantine_rows").select("row_number, reason").eq("import_run_id", r.runId).order("row_number");
    expect(q?.map((x) => x.reason).sort()).toEqual(["conflicting_duplicate", "invalid_phone"]);
  });

  it("a renamed column fails loudly, naming the column, and writes nothing", async () => {
    const before = await counts();
    const headers = BASE_HEADERS.map((h) => (h === "Contract End Date" ? "Contract_End" : h));
    const err = await importBaseFile(manager.db, "drift.xlsx", await workbook(month1(), headers)).catch((e) => e);
    expect(err).toBeInstanceOf(ImportStructureError);
    expect(err.message).toMatch(/Contract End Date/);
    expect(await counts()).toEqual(before);
  });

  it("POST /api/import: 422 naming the column for drift (logged as a failed run), 403 for agents", async () => {
    const { POST } = await import("@/app/api/import/route");
    const form = new FormData();
    const headers = BASE_HEADERS.map((h) => (h === "Contract End Date" ? "Contract_End" : h));
    form.set("file", new File([new Uint8Array(await workbook(month1(), headers))], "drift.xlsx"));
    const res = await POST(new Request("http://localhost/api/import", { method: "POST", headers: { authorization: `Bearer ${manager.token}` }, body: form }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/"Contract End Date" is missing/);
    const { data: runs } = await adminClient().from("import_runs").select("status, file_name").order("created_at", { ascending: false }).limit(1);
    expect(runs?.[0]).toEqual({ status: "failed", file_name: "drift.xlsx" });

    const asAgent = await POST(new Request("http://localhost/api/import", { method: "POST", headers: { authorization: `Bearer ${agent.token}` }, body: form }));
    expect(asAgent.status).toBe(403);
  });

  it("refuses a file that would mark most lines as ported out (a partial export) and writes nothing", async () => {
    // Make the base big enough for the safety check, then upload only one line of it.
    const many = Array.from({ length: 40 }, (_, i) => baseRow({ "Account No": 30000020, "Reg No": "2020/444444/07", "Customer Name": "MAGALIES PROJECTS (PTY) LTD", Msisdn: 861000100 + i }));
    await importBaseFile(manager.db, "big.xlsx", await workbook(many));
    const before = await counts();
    const err = await importBaseFile(manager.db, "partial.xlsx", await workbook(many.slice(0, 1))).catch((e) => e);
    expect(String(err.message)).toMatch(/partial export/);
    expect(await counts()).toEqual(before);
  });
});
