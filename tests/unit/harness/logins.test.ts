import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeLogins, parseTestLogins } from "@/lib/harness/logins";

describe("parseTestLogins", () => {
  it("reads the documented format", () => {
    const p = parseTestLogins("agent: a@kopano.test / Secret-1\nagent: b@kopano.test / Secret-2\nmanager: m@kopano.test / Secret-3");
    expect(p.agents.map((a) => [a.email, a.password])).toEqual([
      ["a@kopano.test", "Secret-1"],
      ["b@kopano.test", "Secret-2"],
    ]);
    expect(p.manager).toMatchObject({ email: "m@kopano.test", password: "Secret-3" });
    expect(p.problems).toEqual([]);
  });

  it("reads bullets, markdown emphasis, code spans, CRLF and other separators", () => {
    const p = parseTestLogins("* **Agent 1**: `A@Kopano.test` | pw-one\r\n- Agent 2 - b@kopano.test - pw two words\r\n1. Manager (Lerato): m@kopano.test, Password: pw-three\r\n");
    expect(p.agents.map((a) => [a.email, a.password])).toEqual([
      ["a@kopano.test", "pw-one"],
      ["b@kopano.test", "pw two words"],
    ]);
    expect(p.manager?.password).toBe("pw-three");
  });

  it("keeps passwords that start like a label (pw-…, pass…)", () => {
    const p = parseTestLogins("agent: a@x.co.za / pw-abc\nagent: b@x.co.za / passphrase9\nmanager: m@x.co.za / Password1");
    expect(p.agents.map((a) => a.password)).toEqual(["pw-abc", "passphrase9"]);
    expect(p.manager?.password).toBe("Password1");
  });

  it("reads role headings with Email/Password lines underneath", () => {
    const p = parseTestLogins("Agent A\nEmail: a@x.co.za\nPassword: one-1\n\nAgent B\nEmail: b@x.co.za\nPassword: two-2\n\nManager login\nEmail: m@x.co.za\nPassword: three-3");
    expect(p.agents.map((a) => a.email)).toEqual(["a@x.co.za", "b@x.co.za"]);
    expect(p.manager).toMatchObject({ email: "m@x.co.za", password: "three-3" });
  });

  it("reads a markdown table", () => {
    const p = parseTestLogins("| Role | Email | Password |\n|---|---|---|\n| agent | a@x.co.za | p1-aaaa |\n| agent | b@x.co.za | p2-bbbb |\n| manager | m@x.co.za | p3-cccc |");
    expect(p.agents.map((a) => a.password)).toEqual(["p1-aaaa", "p2-bbbb"]);
    expect(p.manager?.password).toBe("p3-cccc");
  });

  it("assumes agent, agent, manager when no roles are written, and says so", () => {
    const p = parseTestLogins("a@x.co.za / one\nb@x.co.za / two\nm@x.co.za / three");
    expect(p.manager?.email).toBe("m@x.co.za");
    expect(p.problems.join(" ")).toMatch(/assumed the documented order/);
  });

  it("reports what is missing", () => {
    expect(parseTestLogins("").problems).toEqual(["no test logins were submitted"]);
    expect(parseTestLogins("see the README").problems).toEqual(["no email addresses found in the test logins"]);
    const p = parseTestLogins("agent: a@x.co.za\nmanager: m@x.co.za / three");
    expect(p.problems).toContain("no password found for a@x.co.za");
    expect(p.problems).toContain("expected two agent logins, found 0");
  });

  it("strips zero-width characters and never exposes passwords in the evidence view", () => {
    const p = parseTestLogins("agent: a​@x.co.za / one\nagent: b@x.co.za / two\nmanager: m@x.co.za / three");
    expect(p.agents[0].email).toBe("a@x.co.za");
    expect(JSON.stringify(describeLogins(p))).not.toMatch(/one|two|three/);
  });

  it("picks up a Supabase URL and publishable key written next to the logins, never a service-role key", () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const service = `${b64({ alg: "HS256" })}.${b64({ role: "service_role" })}.${randomBytes(16).toString("base64url")}`;
    const key = ["sb", "publishable", randomBytes(10).toString("hex")].join("_");
    const p = parseTestLogins(`agent: a@x.co.za / one\nagent: b@x.co.za / two\nmanager: m@x.co.za / three\nSupabase URL: https://abcdefghijklmnopqrst.supabase.co\npublishable key: ${key}`);
    expect(p.supabaseUrl).toBe("https://abcdefghijklmnopqrst.supabase.co");
    expect(p.publishableKey).toBe(key);
    const q = parseTestLogins(`agent: a@x.co.za / one\nservice key: ${service}`);
    expect(q.publishableKey).toBeNull();
    expect(q.problems.join(" ")).toMatch(/not used/);
  });
});
