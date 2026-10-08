import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messageBlockReason, pickContactPoint, type ContactPointLite } from "@/lib/messaging";
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
    expect(messageBlockReason({ optedOut: false, template: utility, contacts: [{ ...mobile("opted_in"), value: "+27115550001" }] })).toBe("no_consented_contact");
    expect(messageBlockReason({ optedOut: false, template: { approved: false, category: "utility" }, contacts: [mobile("opted_in")] })).toBe("template_not_approved");
  });

  it("RD-10: picks the best channel first (WhatsApp, mobile, email), then an explicit opt-in", () => {
    const email: ContactPointLite = { id: "e", type: "email", value: "a@b.example", consent_status: "opted_in", verified_at: null };
    const mob: ContactPointLite = { id: "m", type: "mobile", value: "+27821000001", consent_status: "existing_customer_s69_3", verified_at: null };
    const wa: ContactPointLite = { id: "w", type: "whatsapp", value: "+27821000001", consent_status: "existing_customer_s69_3", verified_at: null };
    expect(pickContactPoint([email, mob], "utility")?.id).toBe("m");
    expect(pickContactPoint([email, mob, wa], "utility")?.id).toBe("w");
    expect(pickContactPoint([email, mob, wa], "marketing")?.id).toBe("e");
  });

  it("an opt-out follows the number: no other contact point with that value qualifies", () => {
    const wa: ContactPointLite = { id: "w", type: "whatsapp", value: "+27821000001", consent_status: "opted_in", verified_at: null };
    const out: ContactPointLite = { id: "m", type: "mobile", value: "+27821000001", consent_status: "opted_out", verified_at: null };
    expect(messageBlockReason({ optedOut: false, template: utility, contacts: [wa, out] })).toBe("no_consented_contact");
  });
});

describe.skipIf(!DB_TESTS)("RD-11 in the database and the API", () => {
  let agent: TestUser;
  let manager: TestUser;
  let optedOutId: string;
  let okId: string;
  let consentId: string;
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
        baseRow({ "Account No": 20000003, "Reg No": "2011/000003/07", "Customer Name": "UMOYA FARMING (PTY) LTD", Msisdn: 821100003 }),
      ]),
    );
    // Legal lists the company by a misspelt name only.
    await importOptoutsFile(admin, "optouts.xlsx", await workbook([["Masakhane Plubming", new Date(Date.UTC(2026, 5, 1)), "Opted out", "Asked not to be contacted"]], ["Company", "Date Logged", "Status", "Notes"], "Opt-outs"));
    optedOutId = await customerIdByAccount("20000001");
    okId = await customerIdByAccount("20000002");
    consentId = await customerIdByAccount("20000003");
    agent = await makeUser("agent", "rd11");
    manager = await makeUser("manager", "rd11-m");
    await allocate(optedOutId, agent.id);
    await allocate(okId, agent.id);
    await allocate(consentId, agent.id);
    // The third customer: an opted-in email, and a mobile and WhatsApp on the existing-customer basis.
    const { error: cpErr } = await admin.from("contact_points").insert([
      { customer_id: consentId, type: "email", value: "accounts@umoya.example", consent_status: "opted_in", source: "test" },
      { customer_id: consentId, type: "mobile", value: "+27821100003", consent_status: "existing_customer_s69_3", source: "test" },
      { customer_id: consentId, type: "whatsapp", value: "+27821100003", consent_status: "existing_customer_s69_3", source: "test" },
    ]);
    if (cpErr) throw cpErr;
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

  it("RD-10: queues against the best channel (WhatsApp before mobile before an opted-in email)", async () => {
    const { POST } = await import("@/app/api/messages/route");
    const res = await POST(authedRequest("/api/messages", agent, { customerId: consentId, templateId }));
    expect(res.status).toBe(201);
    expect((await res.json()).message).toMatchObject({ channel: "whatsapp" });
  });

  it("RD-05: after an opt-out on the mobile, nothing goes to that number on any channel, and an agent cannot lift it", async () => {
    const admin = adminClient();
    const { data: mob } = await admin.from("contact_points").select("id").eq("customer_id", consentId).eq("type", "mobile").single();
    const { POST: consent } = await import("@/app/api/contact-points/consent/route");
    expect((await consent(authedRequest("/api/contact-points/consent", agent, { contactPointId: mob!.id, consentStatus: "opted_out" }))).status).toBe(200);

    const { POST: queue } = await import("@/app/api/messages/route");
    const res = await queue(authedRequest("/api/messages", agent, { customerId: consentId, templateId }));
    expect((await res.json()).message).toMatchObject({ channel: "email" });

    const reopened = await consent(authedRequest("/api/contact-points/consent", agent, { contactPointId: mob!.id, consentStatus: "opted_in" }));
    expect(reopened.status).toBe(403);
    const { error } = await agent.db.from("contact_points").update({ consent_status: "opted_in" }).eq("id", mob!.id);
    expect(error?.hint).toBe("opt_out_locked");

  });

  it("RD-05: a new contact point for a number the customer opted out on starts opted out", async () => {
    const { error: outErr } = await agent.db.from("contact_points").update({ consent_status: "opted_out" }).eq("customer_id", okId).eq("value", "+27821100002");
    expect(outErr).toBeNull();
    const { data, error } = await agent.db
      .from("contact_points")
      .insert({ customer_id: okId, type: "whatsapp", value: "+27821100002", consent_status: "opted_in", source: "call" })
      .select("consent_status")
      .single();
    expect(error).toBeNull();
    expect(data?.consent_status).toBe("opted_out");
  });

  it("RD-05: a manager can lift an opt-out only with a reason, which is recorded", async () => {
    const admin = adminClient();
    const { data: mob } = await admin.from("contact_points").select("id").eq("customer_id", consentId).eq("type", "mobile").single();
    const { POST: consent } = await import("@/app/api/contact-points/consent/route");
    const noReason = await consent(authedRequest("/api/contact-points/consent", manager, { contactPointId: mob!.id, consentStatus: "opted_in" }));
    expect(noReason.status).toBe(422);
    const lifted = await consent(authedRequest("/api/contact-points/consent", manager, { contactPointId: mob!.id, consentStatus: "opted_in", reason: "Owner asked to be added back, call of 8 Oct" }));
    expect(lifted.status).toBe(200);
    const { data } = await admin.from("contact_points").select("consent_status, consent_note, consent_changed_by").eq("id", mob!.id).single();
    expect(data).toEqual({ consent_status: "opted_in", consent_note: "Owner asked to be added back, call of 8 Oct", consent_changed_by: manager.id });
  });

  it("BR-C5: a landline cannot be recorded or retyped as a mobile, so it is never messaged", async () => {
    const { error: insErr } = await agent.db.from("contact_points").insert({ customer_id: consentId, type: "mobile", value: "+27115550003", consent_status: "opted_in", source: "call" });
    expect(insErr?.hint).toBe("landline");
    const { data: land, error: landErr } = await agent.db
      .from("contact_points")
      .insert({ customer_id: consentId, type: "landline", value: "+27115550003", consent_status: "unknown", source: "call" })
      .select("id")
      .single();
    expect(landErr).toBeNull();
    const { error: retype } = await agent.db.from("contact_points").update({ type: "mobile" }).eq("id", land!.id);
    expect(retype?.code).toBe("42501");
  });
});
