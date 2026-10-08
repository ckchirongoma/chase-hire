import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));

import { generateBrief, getBrief } from "@/lib/server/brief";
import { POST as briefRoute } from "@/app/api/admin/candidates/[id]/brief/route";
import { consent, fakeFinishedAttempt, fakeParsedCv, makeAdmin, newUser, service } from "../helpers/local";

/**
 * The AI candidate brief for admins: written from the platform's own data without the person's
 * name or contact details, admin-only, rebuilt when the inputs change, and it never changes an
 * application.
 */

const admin = service();

async function applicant(tag: string) {
  const u = await newUser(tag);
  await consent(u.client);
  await fakeParsedCv(u.id);
  await fakeFinishedAttempt(u.id, 4);
  const { data, error } = await u.client.rpc("apply_to_role", { p_slug: "business-analyst" });
  if (error) throw error;
  return { ...u, appId: data as string };
}

describe("candidate brief", () => {
  it("writes an advisory brief per application without names or contact details, and changes nothing else", async () => {
    const u = await applicant("brief");
    const before = (await admin.from("applications").select("stage, status").eq("id", u.appId).single()).data;
    const b = await generateBrief(admin, u.id, null);
    expect(b.stale).toBe(false);
    expect(b.promptVersion).toBe("candidate-brief.v1");
    expect(b.content.summary).toContain("Reasoning stars: 4");
    expect(b.content.summary).toContain("Roles: AI-native Business Analyst");
    expect(b.content.summary).toContain("Contact details: none");
    expect(b.content.recommendations).toEqual([expect.objectContaining({ role: "AI-native Business Analyst", recommendation: "too_early" })]);
    expect((await admin.from("applications").select("stage, status").eq("id", u.appId).single()).data).toEqual(before);

    // Unchanged inputs: the stored brief is reused (same timestamp); new results make it stale.
    const again = await generateBrief(admin, u.id, null);
    expect(again.createdAt).toBe(b.createdAt);
    expect((await getBrief(admin, u.id))!.stale).toBe(false);
    await admin.from("applications").update({ below_hurdle: true }).eq("id", u.appId);
    expect((await getBrief(admin, u.id))!.stale).toBe(true);
    const fresh = await generateBrief(admin, u.id, null);
    expect(fresh.createdAt).not.toBe(b.createdAt);
    expect((await getBrief(admin, u.id))!.stale).toBe(false);
  });

  it("only admins can read briefs or ask for one; candidates never see them", async () => {
    const u = await applicant("brief-rls");
    await generateBrief(admin, u.id, null);
    const { data: own } = await u.client.from("candidate_briefs").select("*");
    expect(own).toEqual([]);

    const post = (id: string) => briefRoute(new Request(`http://x/api/admin/candidates/${id}/brief`, { method: "POST" }), { params: Promise.resolve({ id }) });
    h.client = u.client;
    expect((await post(u.id)).status).toBe(404);

    const boss = await newUser("brief-admin");
    await makeAdmin(boss.id);
    h.client = boss.client;
    const res = await post(u.id);
    expect(res.status).toBe(200);
    expect((await res.json()).content.headline).toMatch(/Stub analyst/);
    expect((await post("not-a-uuid")).status).toBe(400);
    const { data: seen } = await boss.client.from("candidate_briefs").select("user_id").eq("user_id", u.id);
    expect(seen).toHaveLength(1);
  });
});
