import { beforeAll, describe, expect, it } from "vitest";
import { anon, consent, fakeFinishedAttempt, fakeParsedCv, makeAdmin, newUser, service } from "../helpers/local";

type U = Awaited<ReturnType<typeof newUser>>;
let a: U, b: U, admin: U;

beforeAll(async () => {
  [a, b, admin] = await Promise.all([newUser("a"), newUser("b"), newUser("admin")]);
  await makeAdmin(admin.id);
  await consent(a.client);
  await consent(b.client);
  await fakeParsedCv(a.id);
  await fakeParsedCv(b.id);
});

describe("anonymous visitors", () => {
  it("can read active roles only", async () => {
    const { data, error } = await anon().from("roles").select("slug");
    expect(error).toBeNull();
    expect(data!.map((r) => r.slug).sort()).toEqual(["business-analyst", "software-engineer"]);
  });

  it.each(["profiles", "consents", "cvs", "applications", "decisions", "reasoning_items", "reasoning_attempts", "reasoning_responses", "signals", "dedupe_flags", "review_requests", "admins"])(
    "cannot read %s",
    async (table) => {
      const { data, error } = await anon().from(table).select("*").limit(1);
      expect(error ?? (data?.length === 0 ? "empty" : null)).toBeTruthy();
    },
  );
});

describe("function grants", () => {
  it.each([
    ["is_admin", {}],
    ["handle_new_user", {}],
    ["apply_to_role", { p_slug: "business-analyst" }],
    ["admin_decide", { p_application_id: "00000000-0000-0000-0000-000000000000", p_decision: "advance", p_reason: "x".repeat(30) }],
    ["match_cvs", { query_embedding: "[1]", exclude_user: "00000000-0000-0000-0000-000000000000", min_similarity: 0 }],
  ])("anon cannot call %s", async (fn, args) => {
    const { error } = await anon().rpc(fn, args);
    expect(error).not.toBeNull();
  });

  it("signed-in users cannot call trigger helpers or match_cvs", async () => {
    expect((await a.client.rpc("handle_new_user")).error).not.toBeNull();
    const m = await a.client.rpc("match_cvs", { query_embedding: "[1]", exclude_user: a.id, min_similarity: 0 });
    expect(m.error).not.toBeNull();
  });
});

describe("candidates see only their own rows", () => {
  it.each(["profiles", "consents", "cvs"])("%s", async (table) => {
    const { data, error } = await a.client.from(table).select("user_id");
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    expect(data!.every((r) => r.user_id === a.id)).toBe(true);
  });

  it("cannot read another candidate's profile by id", async () => {
    const { data } = await a.client.from("profiles").select("*").eq("user_id", b.id);
    expect(data).toEqual([]);
  });

  it("admin_candidates view shows a candidate only themselves, an admin everyone", async () => {
    const mine = await a.client.from("admin_candidates").select("user_id");
    expect(mine.data!.map((r) => r.user_id)).toEqual([a.id]);
    const all = await admin.client.from("admin_candidates").select("user_id");
    const ids = all.data!.map((r) => r.user_id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it("cannot read item templates, responses (answer keys) or the attempt seed", async () => {
    expect((await a.client.from("reasoning_items").select("*")).data).toEqual([]);
    expect((await a.client.from("reasoning_responses").select("*")).data).toEqual([]);
    const seed = await a.client.from("reasoning_attempts").select("seed");
    expect(seed.error?.message).toMatch(/permission denied/);
  });

  it("cannot change their own email or forge consent timestamps", async () => {
    const forged = await a.client.from("consents").insert({
      notice_version: "x", accepted_processing: true, accepted_ai_assessment: true,
      accepted_offshore_processing: true, accepted_at: "2020-01-01T00:00:00Z",
    });
    expect(forged.error?.message).toMatch(/permission denied/);
    const email = await a.client.from("profiles").update({ email: "evil@example.com" }).eq("user_id", a.id);
    expect(email.error?.message).toMatch(/permission denied/);
  });

  it("consent requires the three core acceptances", async () => {
    const { error } = await a.client.from("consents").insert({
      notice_version: "x", accepted_processing: true, accepted_ai_assessment: false, accepted_offshore_processing: true,
    });
    expect(error).not.toBeNull();
  });

  it("can log client signals about themselves but not server-only kinds", async () => {
    expect((await a.client.from("signals").insert({ context: "t", kind: "blur" })).error).toBeNull();
    expect((await a.client.from("signals").insert({ context: "t", kind: "answer_time" })).error).not.toBeNull();
    expect((await a.client.from("signals").select("*")).data).toEqual([]); // admin-only read
  });
});

describe("no automatic rejections", () => {
  it("candidates cannot write applications or decisions directly", async () => {
    const roles = await anon().from("roles").select("id").limit(1);
    const ins = await a.client.from("applications").insert({ user_id: a.id, role_id: roles.data![0].id });
    expect(ins.error?.message).toMatch(/permission denied/);
    const dec = await a.client.rpc("admin_decide", { p_application_id: crypto.randomUUID(), p_decision: "advance", p_reason: "x".repeat(30) });
    expect(dec.error?.message).toMatch(/admin_only/);
  });

  it("apply_to_role needs a finished reasoning attempt; below hurdle is queued, not rejected", async () => {
    const early = await a.client.rpc("apply_to_role", { p_slug: "business-analyst" });
    expect(early.error?.message).toMatch(/reasoning_required/);

    await fakeFinishedAttempt(a.id, 2); // hurdle is 3★
    const { data: appId, error } = await a.client.rpc("apply_to_role", { p_slug: "business-analyst" });
    expect(error).toBeNull();
    const { data: app } = await a.client.from("applications").select("*").eq("id", appId).single();
    expect(app).toMatchObject({ status: "awaiting_review", below_hurdle: true, stage: "interview", reasoning_stars: 2 });

    // Applying again is idempotent.
    const again = await a.client.rpc("apply_to_role", { p_slug: "business-analyst" });
    expect(again.data).toBe(appId);
  });

  it("even the service role cannot set rejected/advanced without a decision row", async () => {
    const { data: app } = await service().from("applications").select("id").eq("user_id", a.id).single();
    const { error } = await service().from("applications").update({ status: "rejected" }).eq("id", app!.id);
    expect(error?.message).toMatch(/status_change_requires_admin_decision/);
  });

  it("admin_decide requires a 20+ character reason and records the decision", async () => {
    const { data: app } = await service().from("applications").select("id").eq("user_id", a.id).single();
    const short = await admin.client.rpc("admin_decide", { p_application_id: app!.id, p_decision: "advance", p_reason: "ok" });
    expect(short.error?.message).toMatch(/reason_too_short/);

    const reason = "Below hurdle (2 stars) but CV shows 4 years of directly relevant SQL work.";
    const ok = await admin.client.rpc("admin_decide", { p_application_id: app!.id, p_decision: "advance", p_reason: reason });
    expect(ok.error).toBeNull();

    const { data: after } = await a.client.from("applications").select("status").eq("id", app!.id).single();
    expect(after!.status).toBe("advanced");
    const { data: decisions } = await a.client.from("decisions").select("reason, decision, scores_snapshot");
    expect(decisions![0]).toMatchObject({ reason, decision: "advance" });
    expect(decisions![0].scores_snapshot.reasoning.stars).toBe(2);
    expect((await b.client.from("decisions").select("*")).data).toEqual([]);
  });
});

describe("review requests", () => {
  it("a candidate can request a review of their reasoning score, admin can reply", async () => {
    const ins = await b.client.from("review_requests").insert({ stage: "reasoning", message: "Please review my score, my power went off." });
    expect(ins.error).toBeNull();
    const { data: rr } = await admin.client.from("review_requests").select("id").eq("user_id", b.id).single();
    const upd = await admin.client.from("review_requests").update({ response: "Re-sit granted.", status: "responded" }).eq("id", rr!.id);
    expect(upd.error).toBeNull();
    const { data: mine } = await b.client.from("review_requests").select("response");
    expect(mine![0].response).toBe("Re-sit granted.");
    expect((await a.client.from("review_requests").select("*").eq("user_id", b.id)).data).toEqual([]);
  });

  it("cannot attach a review request to someone else's application", async () => {
    const { data: app } = await service().from("applications").select("id").eq("user_id", a.id).single();
    const { error } = await b.client.from("review_requests").insert({ stage: "decision", application_id: app!.id, message: "Review this please." });
    expect(error).not.toBeNull();
  });
});

describe("CV storage", () => {
  const pdf = new Blob(["%PDF-1.4 test"], { type: "application/pdf" });

  it("requires consent before upload", async () => {
    const c = await newUser("noconsent");
    const { error } = await c.client.storage.from("cvs").upload(`${c.id}/cv.pdf`, pdf, { contentType: "application/pdf" });
    expect(error).not.toBeNull();
  });

  it("allows upload only into your own folder", async () => {
    const own = await a.client.storage.from("cvs").upload(`${a.id}/cv-${Date.now()}.pdf`, pdf, { contentType: "application/pdf" });
    expect(own.error).toBeNull();
    const other = await a.client.storage.from("cvs").upload(`${b.id}/cv-${Date.now()}.pdf`, pdf, { contentType: "application/pdf" });
    expect(other.error).not.toBeNull();
  });

  it("rejects non-PDF/DOCX files", async () => {
    const { error } = await a.client.storage
      .from("cvs")
      .upload(`${a.id}/x-${Date.now()}.html`, new Blob(["<html>"], { type: "text/html" }), { contentType: "text/html" });
    expect(error).not.toBeNull();
  });
});

describe("dedupe flags are admin-only", () => {
  it("candidates cannot see or resolve flags", async () => {
    const cvA = (await service().from("cvs").select("id").eq("user_id", a.id).limit(1)).data![0].id;
    await service().from("dedupe_flags").insert({ cv_id: cvA, user_id: a.id, matched_user_id: b.id, kind: "identity", matched_fields: ["email"] });
    expect((await a.client.from("dedupe_flags").select("*")).data).toEqual([]);
    const { data } = await admin.client.from("dedupe_flags").select("id").eq("user_id", a.id);
    expect(data!.length).toBe(1);
    const res = await admin.client.from("dedupe_flags").update({ status: "not_duplicate" }).eq("id", data![0].id);
    expect(res.error).toBeNull();
  });
});
