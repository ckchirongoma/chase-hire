import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applySetCookies, cookieHeaderOf, decodeEntities, looksLikeLoginPage, parseLoginForms, sessionFromCookies, tagAttributes } from "@/lib/harness/app-login";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: object) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.${randomBytes(16).toString("base64url")}`;

describe("login forms (sign-in without the publishable key)", () => {
  it("reads a Next.js server-action form rendered for browsers without JavaScript", () => {
    const html = `<header><a href="/queue">Desk</a></header><form class="card" action="" encType="multipart/form-data" method="POST"><input type="hidden" name="$ACTION_REF_1"/><input type="hidden" name="$ACTION_1:0" value="{&quot;id&quot;:&quot;6081700d&quot;,&quot;bound&quot;:&quot;$@1&quot;}"/><input type="hidden" name="$ACTION_1:1" value="[{&quot;error&quot;:null}]"/><input type="hidden" name="$ACTION_KEY" value="k230eb59"/><input class="input" id="email" type="email" autoComplete="username" required="" name="email"/><input id="password" type="password" required="" name="password"/><button class="btn" type="submit">Sign in</button></form>`;
    const [f] = parseLoginForms(html, "https://desk.example.co.za/login");
    expect(f).toMatchObject({ action: "https://desk.example.co.za/login", method: "POST", multipart: true, emailField: "email", passwordField: "password" });
    expect(f.fields).toEqual([
      ["$ACTION_REF_1", ""],
      ["$ACTION_1:0", '{"id":"6081700d","bound":"$@1"}'],
      ["$ACTION_1:1", '[{"error":null}]'],
      ["$ACTION_KEY", "k230eb59"],
    ]);
  });

  it("reads a classic form with a CSRF token and a username field; skips forms without a password", () => {
    const html = `<form action="/search"><input name="q"></form>
      <form method="post" action="/auth/login"><input type="hidden" name="csrf" value="t&amp;1"><input type="text" name="username"><input type="password" name="pw"><input type="checkbox" name="remember" checked><input type="checkbox" name="other"><button name="go" value="1">Log in</button><button name="alt" value="2">Other</button></form>`;
    const forms = parseLoginForms(html, "https://desk.example.co.za/login");
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatchObject({ action: "https://desk.example.co.za/auth/login", method: "POST", multipart: false, emailField: "username", passwordField: "pw" });
    expect(forms[0].fields).toEqual([
      ["csrf", "t&1"],
      ["remember", "on"],
      ["go", "1"],
    ]);
  });

  it("decodes attributes and entities", () => {
    expect(tagAttributes(`<input type=hidden name='a b' value="x&quot;y" disabled>`)).toEqual({ type: "hidden", name: "a b", value: 'x"y', disabled: "" });
    expect(decodeEntities("A &amp; B &#39;C&#x27;&nbsp;&bogus;")).toBe("A & B 'C' &bogus;");
  });
});

describe("cookies", () => {
  it("keeps set cookies and drops deleted or expired ones", () => {
    const jar = new Map([["old", "1"]]);
    applySetCookies(jar, ["a=1; Path=/; HttpOnly", "b=2; Expires=Wed, 21 Oct 2015 07:28:00 GMT", "old=; Max-Age=0", "c=x=y; Secure"]);
    expect([...jar]).toEqual([
      ["a", "1"],
      ["c", "x=y"],
    ]);
    expect(cookieHeaderOf(jar)).toBe("a=1; c=x=y");
  });

  it("reads the @supabase/ssr session, chunked, with the project URL from the token issuer", () => {
    const token = jwt({ sub: "user-1", role: "authenticated", iss: "https://abcdefghijklmnopqrst.supabase.co/auth/v1", email: "a@x.co.za" });
    const value = `base64-${b64({ access_token: token, refresh_token: "r", user: { id: "user-1", email: "a@x.co.za", pad: "x".repeat(4000) } })}`;
    const jar = new Map<string, string>([
      ["other", "1"],
      ["sb-abcdefghijklmnopqrst-auth-token.1", value.slice(3180)],
      ["sb-abcdefghijklmnopqrst-auth-token.0", value.slice(0, 3180)],
    ]);
    expect(sessionFromCookies(jar)).toMatchObject({ accessToken: token, userId: "user-1", email: "a@x.co.za", issuerOrigin: "https://abcdefghijklmnopqrst.supabase.co" });
  });

  it("reads URI-encoded JSON and the older auth-helpers array; ignores junk", () => {
    const token = jwt({ sub: "user-2", iss: "http://127.0.0.1:54321/auth/v1" });
    const raw = new Map([["sb-127-auth-token", encodeURIComponent(JSON.stringify({ access_token: token, user: { id: "user-2" } }))]]);
    expect(sessionFromCookies(raw)).toMatchObject({ userId: "user-2", issuerOrigin: "http://127.0.0.1:54321" });
    const legacy = new Map([["sb-xyz-auth-token", encodeURIComponent(JSON.stringify([token, "refresh", null]))]]);
    expect(sessionFromCookies(legacy)?.userId).toBe("user-2");
    expect(sessionFromCookies(new Map([["sb-xyz-auth-token", "base64-not json"]]))).toBeNull();
    expect(sessionFromCookies(new Map([["session", "abc"]]))).toBeNull();
  });

  it("recognises a redirect back to the login page", () => {
    expect(looksLikeLoginPage("/login?error=1")).toBe(true);
    expect(looksLikeLoginPage("/queue")).toBe(false);
  });
});
