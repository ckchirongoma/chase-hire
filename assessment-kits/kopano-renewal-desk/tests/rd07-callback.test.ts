import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OutcomeInput } from "@/lib/validation";
import { DB_TESTS, adminClient, allocate, authedRequest, baseRow, customerIdByAccount, makeUser, resetDatabase, workbook, type TestUser } from "./helpers/db";

const id = "6f1c1f5e-3b7a-4c55-9d6e-0a0b0c0d0e0f";
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();

describe("RD-07: a call back needs a callback date (server-side validation)", () => {
  it("rejects call_back without a date", () => {
    const r = OutcomeInput.safeParse({ customerId: id, outcome: "call_back" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual(["nextActionAt"]);
  });

  it("rejects a callback date in the past", () => {
    expect(OutcomeInput.safeParse({ customerId: id, outcome: "call_back", nextActionAt: "2020-01-01T09:00:00Z" }).success).toBe(false);
  });

  it("accepts call_back with a future date, and other outcomes without one", () => {
    expect(OutcomeInput.safeParse({ customerId: id, outcome: "call_back", nextActionAt: tomorrow() }).success).toBe(true);
    expect(OutcomeInput.safeParse({ customerId: id, outcome: "no_answer" }).success).toBe(true);
  });
});

describe.skipIf(!DB_TESTS)("RD-07 in the database and the API", () => {
  let agent: TestUser;
  let customerId: string;

  beforeAll(async () => {
    await resetDatabase();
    const { importBaseFile } = await import("@/lib/import/base");
    await importBaseFile(adminClient(), "rd07.xlsx", await workbook([baseRow({})]));
    customerId = await customerIdByAccount("10000001");
    agent = await makeUser("agent", "rd07");
    await allocate(customerId, agent.id);
  });

  afterAll(resetDatabase);

  it("the database refuses a call_back without a date even when the API is bypassed (REST)", async () => {
    const { error } = await agent.db.from("interactions").insert({ customer_id: customerId, agent_id: agent.id, outcome: "call_back" });
    expect(error?.code).toBe("23514");
  });

  it("a forged created_at cannot make a past callback date valid (REST)", async () => {
    const { error } = await agent.db
      .from("interactions")
      .insert({ customer_id: customerId, agent_id: agent.id, outcome: "call_back", next_action_at: "2026-01-02T09:00:00Z", created_at: "2026-01-01T09:00:00Z" });
    expect(error?.code).toBe("23514");
  });

  it("history cannot be backdated: the database records the time and the signed-in agent", async () => {
    const before = Date.now();
    const { data, error } = await agent.db
      .from("interactions")
      .insert({ customer_id: customerId, agent_id: agent.id, outcome: "no_answer", created_at: "2020-01-01T09:00:00Z" })
      .select("agent_id, created_at")
      .single();
    expect(error).toBeNull();
    expect(data?.agent_id).toBe(agent.id);
    expect(new Date(data!.created_at).getTime()).toBeGreaterThanOrEqual(before - 60_000);
    const { error: editError, data: edited } = await agent.db.from("interactions").update({ notes: "changed" }).eq("customer_id", customerId).select("id");
    expect(editError !== null || (edited ?? []).length === 0).toBe(true);
  });

  it("POST /api/outcomes answers 422 for call_back without a date and 201 with one", async () => {
    const { POST } = await import("@/app/api/outcomes/route");
    const bad = await POST(authedRequest("/api/outcomes", agent, { customerId, outcome: "call_back" }));
    expect(bad.status).toBe(422);
    expect((await bad.json()).fields.nextActionAt).toMatch(/callback date/);
    const ok = await POST(authedRequest("/api/outcomes", agent, { customerId, outcome: "call_back", nextActionAt: tomorrow(), notes: "Owner back on Monday" }));
    expect(ok.status).toBe(201);
  });

  it("POST /api/outcomes needs a signed-in user", async () => {
    const { POST } = await import("@/app/api/outcomes/route");
    expect((await POST(authedRequest("/api/outcomes", null, { customerId, outcome: "no_answer" }))).status).toBe(401);
  });
});
