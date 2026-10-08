import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messageBlockReason, type ContactPointLite } from "@/lib/messaging";
import { DB_TESTS, adminClient, allocate, authedRequest, baseRow, customerIdByAccount, makeUser, resetDatabase, workbook, type TestUser } from "./helpers/db";

const mobile = (consent: ContactPointLite["consent_status"]): ContactPointLite => ({ id: "c1", type: "mobile", consent_status: consent, verified_at: null });
const utility = { approved: true, category: "utility" as const };
const marketing = { approved: true, category: "marketing" as const };

describe("RD-11: opt-out and consent rules for messages", () => {
  it("blocks an opted-out customer whatever their contact consent says", () => {
    expect(messageBlockReason({ optedOut: true, template: utility, contacts: [mobile("opted_in")] })).toBe("opted_out");
  });

  it("allows utility messages on the existing-customer basis, marketing only with an opt-in", () => {
    expect(messageBlockReason({ optedOut: false, template: utility, contacts: [mobile("existing_customer_s69_3")] })).toBeNull();
    expect(messageBlockReason({ optedOut: false, template: marketing, contacts: [mobile("existing_customer_s69_3")] })).toBe("no_consented_contact");
    expect(messageBlockReason({ optedOut: false, template: marketing, contacts: [mobile("opted_in")] })).toBeNull();
  });

  it("never messages a landline, and never uses an unapproved template", () => {
    expect(messageBlockReason({ optedOut: false, template: utility, contacts: [{ ...mobile("opted_in"), type: "landline" }] })).toBe("no_consented_contact");
    expect(messageBlockReason({ optedOut: false, template: { approved: false, category: "utility" }, contacts: [mobile("opted_in")] })).toBe("template_not_approved");
  });
});

describe.skipIf(!DB_TESTS)("RD-11 in the database and the API", () => {
  let agent: TestUser;
  let optedOutId: string;
  let okId: string;
  let templateId: string;

  beforeAll(async () => {
    await resetDatabase();
    const admin = adminClient();
    const { importBaseFile } = await import("@/lib/import/base");
    const { importOptoutsFile } = await import("@/lib/import/optouts");
    await importBaseFile(
      admin,
      "rd11.xlsx",
      await workbook([
        baseRow({ "Account No": 20000001, "Reg No": "2011/000001/07", "Customer Name": "MASAKHANE PLUMBING (PTY) LTD", Msisdn: 821100001 }),
        baseRow({ "Account No": 20000002, "Reg No": "2011/000002/07", "Customer Name": "LESEDI SOLAR CC", Msisdn: 821100002 }),
      ]),
    );
    // Legal lists the company by a misspelt name only.
    await importOptoutsFile(admin, "optouts.xlsx", await workbook([["Masakhane Plubming", new Date(Date.UTC(2026, 5, 1)), "Opted out", "Asked not to be contacted"]], ["Company", "Date Logged", "Status", "Notes"], "Opt-outs"));
    optedOutId = await customerIdByAccount("20000001");
    okId = await customerIdByAccount("20000002");
    agent = await makeUser("agent", "rd11");
    await allocate(optedOutId, agent.id);
    await allocate(okId, agent.id);
    for (const [customer_id, value] of [[optedOutId, "+27821100001"], [okId, "+27821100002"]]) {
      const { error } = await admin.from("contact_points").insert({ customer_id, type: "mobile", value, consent_status: "opted_in", source: "test" });
      if (error) throw error;
    }
    const { data, error } = await admin.from("templates").upsert({ name: "Contract end reminder", category: "utility", body: "Your contract ends soon. Reply STOP to opt out.", approved: true }, { onConflict: "name" }).select("id").single();
    if (error) throw error;
    templateId = data.id;
  });

  afterAll(resetDatabase);

  it("matches the misspelt opt-out entry to the customer", async () => {
    const { data } = await adminClient().from("optouts").select("customer_id, match_method").single();
    expect(data).toEqual({ customer_id: optedOutId, match_method: "fuzzy" });
  });

  it("the database refuses to queue a message to the opted-out customer, even through REST", async () => {
    const { error } = await agent.db.from("message_queue").insert({ customer_id: optedOutId, template_id: templateId, created_by: agent.id });
    expect(error?.message).toMatch(/opt-out list/);
    expect(error?.hint).toBe("opted_out");
  });

  it("POST /api/messages answers 409 opted_out for them, and queues for a consented customer", async () => {
    const { POST } = await import("@/app/api/messages/route");
    const blocked = await POST(authedRequest("/api/messages", agent, { customerId: optedOutId, templateId }));
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).reason).toBe("opted_out");
    const ok = await POST(authedRequest("/api/messages", agent, { customerId: okId, templateId }));
    expect(ok.status).toBe(201);
    expect((await ok.json()).message).toMatchObject({ status: "queued", channel: "sms" });
  });
});
