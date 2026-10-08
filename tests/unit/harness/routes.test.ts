import { describe, expect, it, vi } from "vitest";

// The route plumbing only: who may call, what is accepted, how form posts come back.
const auth = vi.hoisted(() => ({ signedIn: true, admin: true }));
vi.mock("@/lib/server/route", async () => {
  const { NextResponse } = await import("next/server");
  return {
    routeUser: async () => (auth.signedIn ? { user: { id: "u1", email: "admin@example.co.za" }, supabase: {} } : NextResponse.json({ error: "Not signed in" }, { status: 401 })),
    errorResponse: () => NextResponse.json({ error: "x" }, { status: 500 }),
  };
});
vi.mock("@/lib/server/auth", () => ({ isAdmin: async () => auth.admin }));

const { adminHarnessRequest, FLASH_COOKIE, harnessResponse, Overrides, readFlash } = await import("@/lib/server/harness");
const { NextResponse } = await import("next/server");

const req = (init: { body?: string; type?: string; origin?: string | null; referer?: string }) =>
  new Request("https://hire.example.co.za/api/admin/harness/x/url", {
    method: "POST",
    body: init.body ?? "",
    headers: {
      host: "hire.example.co.za",
      ...(init.type ? { "content-type": init.type } : {}),
      ...(init.origin !== null ? { origin: init.origin ?? "https://hire.example.co.za" } : {}),
      ...(init.referer ? { referer: init.referer } : {}),
    },
  });

describe("admin harness routes", () => {
  it("404 for signed-in non-admins, 401 when signed out", async () => {
    auth.admin = false;
    expect(((await adminHarnessRequest(req({ type: "application/json", body: "{}" }))) as Response).status).toBe(404);
    auth.admin = true;
    auth.signedIn = false;
    expect(((await adminHarnessRequest(req({ type: "application/json", body: "{}" }))) as Response).status).toBe(401);
    auth.signedIn = true;
  });

  it("accepts JSON and same-origin forms; refuses cross-site posts and other bodies", async () => {
    const j = await adminHarnessRequest(req({ type: "application/json", body: JSON.stringify({ confirm: true }) }));
    expect(j).toMatchObject({ isForm: false, body: { confirm: true } });
    const f = await adminHarnessRequest(req({ type: "application/x-www-form-urlencoded", body: "confirm=yes&supabase_url=" }));
    expect(f).toMatchObject({ isForm: true, body: { confirm: "yes", supabase_url: "" } });
    expect(((await adminHarnessRequest(req({ type: "application/x-www-form-urlencoded", body: "a=1", origin: "https://evil.example" }))) as Response).status).toBe(403);
    expect(((await adminHarnessRequest(req({ type: "application/x-www-form-urlencoded", body: "a=1", origin: null }))) as Response).status).toBe(403);
    expect(((await adminHarnessRequest(req({ type: "text/plain", body: "{}" }))) as Response).status).toBe(415);
  });

  it("answers JSON callers with JSON and form posts with a 303 back to the admin page plus a flash", async () => {
    const r = req({ type: "application/json", referer: "https://hire.example.co.za/admin/candidates/abc?tab=work" });
    const json = harnessResponse(r, { isForm: false }, "sub-1", { ok: false, message: "nope", status: 409 });
    expect(json.status).toBe(409);
    expect(await json.json()).toEqual({ error: "nope" });

    const form = harnessResponse(r, { isForm: true }, "sub-1", { ok: true, message: "URL checks finished." });
    expect(form.status).toBe(303);
    expect(form.headers.get("location")).toBe("/admin/candidates/abc?tab=work#harness-sub-1");
    const cookie = form.cookies.get(FLASH_COOKIE)!;
    expect(cookie.path).toBe("/admin");
    expect(readFlash(cookie.value, "sub-1")).toMatchObject({ ok: true, msg: "URL checks finished." });
    expect(readFlash(cookie.value, "another")).toBeNull();
    expect(readFlash("garbage", "sub-1")).toBeNull();

    // A referer from elsewhere never becomes the redirect target.
    const off = harnessResponse(req({ type: "application/json", referer: "https://evil.example/admin/x" }), { isForm: true }, "s", { ok: true, message: "m" });
    expect(off.headers.get("location")).toBe("/admin/candidates#harness-s");
    expect(off).toBeInstanceOf(NextResponse);
  });

  it("validates the Supabase overrides", () => {
    expect(Overrides.parse({ supabase_url: "", anon_key: "" })).toEqual({ supabase_url: undefined, anon_key: undefined });
    expect(Overrides.safeParse({ supabase_url: "javascript:alert(1)" }).success).toBe(false);
    expect(Overrides.safeParse({ anon_key: "abc def" }).success).toBe(false);
    expect(Overrides.parse({ supabase_url: "https://abcdefghijklmnopqrst.supabase.co" }).supabase_url).toBe("https://abcdefghijklmnopqrst.supabase.co");
  });
});
