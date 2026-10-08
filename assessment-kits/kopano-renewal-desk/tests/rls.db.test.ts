import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importBaseFile } from "@/lib/import/base";
import { DB_TESTS, adminClient, allocate, anonClient, authedRequest, baseRow, customerIdByAccount, makeUser, resetDatabase, workbook, type TestUser } from "./helpers/db";

describe.skipIf(!DB_TESTS)("access control (RLS) and the AI route", () => {
  let a: TestUser;
  let b: TestUser;
  let custA: string;
  let custB: string;

  beforeAll(async () => {
    await resetDatabase();
    await importBaseFile(
      adminClient(),
      "rls.xlsx",
      await workbook([
        baseRow({ "Account No": 40000001, "Reg No": "2001/000001/07", "Customer Name": "PROTEA GLASS (PTY) LTD", Msisdn: 821400001 }),
        baseRow({ "Account No": 40000002, "Reg No": "2001/000002/07", "Customer Name": "FYNBOS TRAVEL (PTY) LTD", Msisdn: 821400002 }),
      ]),
    );
    custA = await customerIdByAccount("40000001");
    custB = await customerIdByAccount("40000002");
    a = await makeUser("agent", "rls-a");
    b = await makeUser("agent", "rls-b");
    await allocate(custA, a.id);
    await allocate(custB, b.id);
    const { error } = await b.db.from("interactions").insert({ customer_id: custB, agent_id: b.id, outcome: "no_answer" });
    expect(error).toBeNull();
  });

  afterAll(resetDatabase);

  it("anonymous visitors can read nothing and write nothing", async () => {
    const anon = anonClient();
    for (const t of ["customers", "lines", "interactions", "contact_points", "allocations", "optouts"]) {
      const { data, error } = await anon.from(t).select("*").limit(1);
      expect([t, error !== null || (data ?? []).length === 0]).toEqual([t, true]);
    }
    const { error } = await anon.from("customers").insert({ legal_name: "X", normalised_name: "X" });
    expect(error).not.toBeNull();
  });

  it("an agent sees only allocated customers, their lines and their history", async () => {
    const { data: customers } = await a.db.from("customers").select("id");
    expect(customers?.map((c) => c.id)).toEqual([custA]);
    const { data: lines } = await a.db.from("lines").select("msisdn_e164");
    expect(lines?.map((l) => l.msisdn_e164)).toEqual(["+27821400001"]);
    const { data: theirs } = await a.db.from("interactions").select("id").eq("agent_id", b.id);
    expect(theirs).toEqual([]);
    const { data: allocations } = await a.db.from("allocations").select("agent_id");
    expect(allocations?.every((x) => x.agent_id === a.id)).toBe(true);
  });

  it("an agent cannot log an outcome on another agent's customer (REST or API)", async () => {
    const { error } = await a.db.from("interactions").insert({ customer_id: custB, agent_id: a.id, outcome: "no_answer" });
    expect(error).not.toBeNull();
    const { POST, GET } = await import("@/app/api/outcomes/route");
    expect((await POST(authedRequest("/api/outcomes", a, { customerId: custB, outcome: "no_answer" }))).status).toBe(404);
    expect((await GET(authedRequest(`/api/outcomes?customerId=${custB}`, a))).status).toBe(404);
  });

  it("POST /api/summary: 401 when signed out, 404 for someone else's customer, 429 once the per-user limit is used", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const { POST } = await import("@/app/api/summary/route");
    expect((await POST(authedRequest("/api/summary", null, { customerId: custA }))).status).toBe(401);
    expect((await POST(authedRequest("/api/summary", a, { customerId: custB }))).status).toBe(404);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await POST(authedRequest("/api/summary", a, { customerId: custA }))).status);
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s !== 429).every((s) => s === 503)).toBe(true);
  });

  it("a login that is not a Desk user sees nothing, and agents cannot run the internal helpers", async () => {
    const admin = adminClient();
    await admin.from("templates").upsert({ name: "RLS probe template", category: "utility", body: "Reply STOP to opt out.", approved: true }, { onConflict: "name" });
    const email = `test-outsider-${Date.now()}@example.co.za`;
    const { error: cErr } = await admin.auth.admin.createUser({ email, password: "Test-only-password-123", email_confirm: true });
    expect(cErr).toBeNull();
    const outsider = anonClient();
    await outsider.auth.signInWithPassword({ email, password: "Test-only-password-123" });
    for (const t of ["templates", "priceplan_rules", "customers", "agents"]) {
      const { data } = await outsider.from(t).select("*").limit(1);
      expect([t, (data ?? []).length]).toEqual([t, 0]);
    }
    const { data: forAgent } = await a.db.from("templates").select("id").limit(1);
    expect((forAgent ?? []).length).toBe(1);
    for (const fn of ["match_optouts", "refresh_contract_status"]) {
      const { error } = await a.db.rpc(fn);
      expect([fn, error !== null]).toEqual([fn, true]);
    }
  });

  it("GET /api/health reports the database", async () => {
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: "ok" });
  });
});
