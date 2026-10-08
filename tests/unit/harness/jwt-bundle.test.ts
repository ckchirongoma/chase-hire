import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cspConnectOrigins, extractPageLinks, extractScriptUrls, extractSupabaseConfig } from "@/lib/harness/bundle";
import { decodeJwt, findJwts, scanSecrets } from "@/lib/harness/jwt";

// Built at run time: nothing secret-shaped is committed.
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: object) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.${randomBytes(32).toString("base64url")}`;
const secretKey = () => ["sb", "secret", randomBytes(16).toString("hex")].join("_");
const publishable = () => ["sb", "publishable", randomBytes(12).toString("hex")].join("_");

describe("JWT and secret detection (U2)", () => {
  it("decodes claims and spots the service role", () => {
    const service = jwt({ iss: "supabase", ref: "abcdefghijklmnopqrst", role: "service_role" });
    const anon = jwt({ iss: "supabase", ref: "abcdefghijklmnopqrst", role: "anon" });
    expect(decodeJwt(service)?.role).toBe("service_role");
    const s = scanSecrets(`const a="${anon}";const b='${service}';`);
    expect(s.serviceRoleJwts).toHaveLength(1);
    expect(s.serviceRoleJwts[0].preview).toMatch(/^eyJ.{9}…$/);
    expect(s.otherJwtRoles).toEqual(["anon"]);
    expect(s.anonJwts[0].ref).toBe("abcdefghijklmnopqrst");
  });

  it("finds sb_secret_ keys without keeping them", () => {
    const k = secretKey();
    const s = scanSecrets(`x=${JSON.stringify(k)}`);
    expect(s.secretKeys).toHaveLength(1);
    expect(s.secretKeys[0]).not.toBe(k);
    expect(s.secretKeys[0].endsWith("…")).toBe(true);
  });

  it("ignores things that only look like JWTs", () => {
    expect(findJwts("eyJhbGciOi.eyJzdWIiOi.abc")).toEqual([]);
    expect(decodeJwt("eyJub3Q.json.x")).toBeNull();
    expect(scanSecrets("var t='eyJhbGci';").serviceRoleJwts).toEqual([]);
  });
});

describe("bundle reading", () => {
  const base = new URL("https://desk.example.co.za/");

  it("collects same-origin scripts from tags, preloads and the RSC payload", () => {
    const html = `<html><head>
      <script src="/_next/static/chunks/webpack-1.js" async></script>
      <script src="https://cdn.other.example/x.js"></script>
      <link rel="preload" as="script" href="/_next/static/chunks/main-2.js">
      <link rel="preload" as="style" href="/_next/static/css/app.css">
      </head><body><script>self.__next_f.push([1,"3:I[\\"static/chunks/app/queue/page-3.js\\"]\\n4:\\"\\/_next\\/static\\/chunks\\/app\\/layout-4.js\\""])</script></body></html>`;
    expect(extractScriptUrls(html, base).sort()).toEqual(
      [
        "https://desk.example.co.za/_next/static/chunks/app/layout-4.js",
        "https://desk.example.co.za/_next/static/chunks/app/queue/page-3.js",
        "https://desk.example.co.za/_next/static/chunks/main-2.js",
        "https://desk.example.co.za/_next/static/chunks/webpack-1.js",
      ].sort(),
    );
  });

  it("collects crawlable page links, not APIs, assets or sign-out", () => {
    const html = `<a href="/queue">Q</a><a href="/customers/1">C</a><a href="/api/health">h</a><a href="/logo.png">l</a><a href="/auth/signout">x</a><a href="https://elsewhere.example/">e</a><a href="#top">t</a>`;
    expect(extractPageLinks(html, base)).toEqual(["https://desk.example.co.za/queue", "https://desk.example.co.za/customers/1"]);
  });

  it("finds the Supabase URL and publishable key", () => {
    const key = publishable();
    const cfg = extractSupabaseConfig([`fetch("https://openrouter.ai/api/v1/chat");let c=(0,s.createBrowserClient)("https://abcdefghijklmnopqrst.supabase.co","${key}")`]);
    expect(cfg.key).toBe(key);
    expect(cfg.keyKind).toBe("publishable");
    expect(cfg.candidates[0]).toEqual({ url: "https://abcdefghijklmnopqrst.supabase.co", via: "supabase-host" });
    expect(cfg.candidates.map((c) => c.url)).not.toContain("https://openrouter.ai");
  });

  it("uses the URL next to the key for custom domains, and the JWT ref for legacy anon keys", () => {
    const key = publishable();
    const near = extractSupabaseConfig([`a("https://fonts.googleapis.com/css");b("https://db.kopano.example","${key}")`], "https://desk.example.co.za");
    expect(near.candidates[0]).toEqual({ url: "https://db.kopano.example", via: "near-key" });
    const anon = jwt({ iss: "supabase", ref: "zyxwvutsrqponmlkjihg", role: "anon" });
    const legacy = extractSupabaseConfig([`k="${anon}"`]);
    expect(legacy.keyKind).toBe("anon-jwt");
    expect(legacy.candidates[0]).toEqual({ url: "https://zyxwvutsrqponmlkjihg.supabase.co", via: "jwt-ref" });
  });

  it("reads the Supabase URL from the CSP connect-src of apps that keep Supabase server-side", () => {
    const csp = ["default-src 'self'; connect-src 'self' https://openrouter.ai https://abcdefghijklmnopqrst.supabase.co wss://abcdefghijklmnopqrst.supabase.co https://*.sentry.io; frame-ancestors 'none'"];
    expect(cspConnectOrigins(csp)).toEqual(["https://abcdefghijklmnopqrst.supabase.co", "https://openrouter.ai"]);
    const cfg = extractSupabaseConfig(["no keys here"], "https://desk.example.co.za", ["connect-src 'self' http://127.0.0.1:55321"]);
    expect(cfg.candidates).toEqual([{ url: "http://127.0.0.1:55321", via: "csp" }]);
    expect(cfg.key).toBeNull();
  });

  it("reports no key when there is none", () => {
    expect(extractSupabaseConfig(["console.log('hi')"]).key).toBeNull();
  });
});
