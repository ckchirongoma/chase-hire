import { describe, expect, it } from "vitest";
import type dns from "node:dns";
import { isBlockedHostname, isPrivateAddress, parseGithubRepo, parseHttpsUrl, parseIPv6 } from "@/lib/work/url";
import { assertFetchableUrl, captureUrl, guardedLookup, SsrfError, type Resolver } from "@/lib/server/snapshot";

describe("isPrivateAddress: IPv4", () => {
  it.each([
    "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.1.1", "127.0.0.1", "127.255.255.255",
    "169.254.169.254", "169.254.0.1", "0.0.0.0", "0.1.2.3", "100.64.0.1", "224.0.0.1", "255.255.255.255", "198.18.0.1",
  ])("blocks %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "100.63.255.255", "203.0.112.1", "41.0.0.1"])(
    "allows %s",
    (ip) => expect(isPrivateAddress(ip)).toBe(false),
  );

  it("treats anything unparseable as private", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
    expect(isPrivateAddress("256.1.1.1")).toBe(true);
    expect(isPrivateAddress("1.2.3")).toBe(true);
  });
});

describe("isPrivateAddress: IPv6", () => {
  it.each([
    "::1", "::", "0:0:0:0:0:0:0:1", "fc00::1", "fd12:3456::1", "fd00:ec2::254", "fe80::1", "fe80::1%eth0", "febf::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "::127.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1",
    "2002:7f00:1::", "2002:c0a8:101::1", "2001::1", "2001:db8::1", "[::1]",
  ])("blocks %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"])("allows %s", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );

  it("parses compressed and dotted forms to 16 bytes", () => {
    expect(parseIPv6("::ffff:1.2.3.4")?.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
    expect(parseIPv6("1::")?.length).toBe(16);
    expect(parseIPv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIPv6("1::2::3")).toBeNull();
    expect(parseIPv6("1:2:3:4:5:6:7::8")).toBeNull();
    expect(parseIPv6("gggg::1")).toBeNull();
  });
});

describe("hostname tricks (WHATWG-normalised)", () => {
  it.each([
    "http://2130706433/", // decimal 127.0.0.1
    "http://0x7f.1/", // hex
    "http://017700000001/", // octal
    "http://127.1/", // short form
    "http://0/",
    "http://[::ffff:127.0.0.1]/",
    "http://[0:0:0:0:0:ffff:7f00:1]/",
    "http://[::]/",
    "http://LOCALHOST./",
    "http://api.localhost/",
    "http://metadata.google.internal/",
    "http://169.254.169.254/latest/meta-data/",
    "http://2852039166/", // 169.254.169.254 as a decimal
    "http://intranet/",
  ])("blocks %s", (raw) => {
    const url = new URL(raw);
    expect(isBlockedHostname(url.hostname)).toBe(true);
    expect(() => assertFetchableUrl(url, false)).toThrow(SsrfError);
  });

  it("allows public names", () => {
    expect(isBlockedHostname("example.com")).toBe(false);
    expect(isBlockedHostname("my-app.vercel.app.")).toBe(false);
  });

  it("refuses other schemes and credentials even when private hosts are allowed", () => {
    for (const raw of ["file:///etc/passwd", "ftp://example.com/", "gopher://example.com/", "javascript:alert(1)", "data:text/html,hi"]) {
      expect(() => assertFetchableUrl(new URL(raw), true)).toThrow(SsrfError);
    }
    expect(() => assertFetchableUrl(new URL("https://user:pw@example.com/"), true)).toThrow(SsrfError);
  });
});

describe("parseHttpsUrl / parseGithubRepo", () => {
  it("accepts public https links only", () => {
    expect(parseHttpsUrl("https://kopano-desk.vercel.app/queue")?.hostname).toBe("kopano-desk.vercel.app");
    expect(parseHttpsUrl("  https://www.loom.com/share/abc  ")).not.toBeNull();
    for (const bad of ["http://example.com", "https://localhost:3000", "https://127.0.0.1/", "https://[::1]/", "https://10.1.2.3", "https://a:b@example.com", "example.com", "", `https://example.com/${"a".repeat(2100)}`]) {
      expect(parseHttpsUrl(bad)).toBeNull();
    }
  });

  it("normalises GitHub repo URLs and rejects anything else", () => {
    expect(parseGithubRepo("https://github.com/someone/kopano-desk")).toEqual({ owner: "someone", repo: "kopano-desk", url: "https://github.com/someone/kopano-desk" });
    expect(parseGithubRepo("https://www.github.com/some-one/desk.git/")?.url).toBe("https://github.com/some-one/desk");
    for (const bad of [
      "http://github.com/a/b",
      "https://github.com/a",
      "https://github.com/a/b/tree/main",
      "https://gitlab.com/a/b",
      "https://github.com.evil.com/a/b",
      "https://github.com/-bad/repo",
      "https://github.com/a/..",
      "https://github.com/a/b?tab=x",
    ]) {
      expect(parseGithubRepo(bad)).toBeNull();
    }
  });
});

describe("guardedLookup (the connect-time DNS check)", () => {
  const fake = (addrs: { address: string; family: number }[]): Resolver => async () => addrs;
  const run = (lookup: ReturnType<typeof guardedLookup>, options: dns.LookupOptions) =>
    new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
      (lookup as unknown as (h: string, o: dns.LookupOptions, cb: (e: Error | null, a: unknown, f?: number) => void) => void)("x.example", options, (err, address, family) =>
        resolve({ err, address, family }),
      ),
    );

  it("refuses a public name that resolves to a private address (DNS rebinding)", async () => {
    const res = await run(guardedLookup({ allowPrivate: false, resolve: fake([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]) }), {});
    expect(res.err).toBeInstanceOf(SsrfError);
  });

  it("refuses IPv6 loopback and metadata answers", async () => {
    for (const address of ["::1", "fd00:ec2::254", "::ffff:169.254.169.254"]) {
      const res = await run(guardedLookup({ allowPrivate: false, resolve: fake([{ address, family: 6 }]) }), { all: true });
      expect(res.err).toBeInstanceOf(SsrfError);
    }
  });

  it("returns public answers in both callback shapes", async () => {
    const lookup = guardedLookup({ allowPrivate: false, resolve: fake([{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }]) });
    expect(await run(lookup, {})).toMatchObject({ err: null, address: "93.184.216.34", family: 4 });
    expect((await run(lookup, { all: true })).address).toHaveLength(2);
    expect(await run(lookup, { family: 6 })).toMatchObject({ address: "2606:2800:220:1::1", family: 6 });
  });

  it("lets private answers through only when allowed (tests)", async () => {
    const res = await run(guardedLookup({ allowPrivate: true, resolve: fake([{ address: "127.0.0.1", family: 4 }]) }), {});
    expect(res).toMatchObject({ err: null, address: "127.0.0.1" });
  });

  it("captureUrl never connects to a private literal and never throws", async () => {
    const snap = await captureUrl("deployed_url", "http://169.254.169.254/latest/meta-data/", { allowPrivate: false });
    expect(snap.status).toBeNull();
    expect(snap.error).toMatch(/not allowed/);
    const viaDns = await captureUrl("mvp_url", "http://rebind.example/", { allowPrivate: false, resolve: fake([{ address: "127.0.0.1", family: 4 }]) });
    expect(viaDns.error).toMatch(/private/);
    const junk = await captureUrl("loom_url", "not a url");
    expect(junk.error).toBeTruthy();
  });
});
