/**
 * URL validation for work submissions and the SSRF guard used by the snapshotter.
 * Pure (no Node APIs), so the submission form can use the same checks.
 *
 * Hostnames are taken from the WHATWG URL parser, which already normalises numeric IPv4 tricks
 * ("http://2130706433/", "http://0x7f.1/", "http://017700000001/", "http://127.1/" all become
 * "127.0.0.1") and IPv6 literals ("[::ffff:127.0.0.1]" becomes "[::ffff:7f00:1]").
 */

const MAX_URL_LENGTH = 2048;

// ───────────────────────── IP parsing ─────────────────────────

/** Strict dotted-quad IPv4 → 4 bytes, or null. */
export function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** IPv6 (optionally with an embedded dotted IPv4 tail and/or a %zone) → 16 bytes, or null. */
export function parseIPv6(input: string): number[] | null {
  let s = input.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!s.includes(":") || /[^0-9a-f:.]/.test(s)) return null;

  // A dotted IPv4 tail ("::ffff:1.2.3.4") becomes two hex groups ("::ffff:102:304").
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }

  const doubles = s.split("::");
  if (doubles.length > 2) return null;
  const head = doubles[0] ? doubles[0].split(":") : [];
  const rest = doubles.length === 2 && doubles[1] ? doubles[1].split(":") : [];
  const groups = head.length + rest.length;
  if (doubles.length === 2 ? groups > 7 : groups !== 8) return null;
  const all = [...head, ...new Array(8 - groups).fill("0"), ...rest];

  const bytes: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

function inV4(b: number[], net: [number, number, number, number], bits: number): boolean {
  for (let i = 0; i < 4; i++) {
    const take = Math.max(0, Math.min(8, bits - i * 8));
    if (take === 0) return true;
    const mask = (0xff << (8 - take)) & 0xff;
    if ((b[i] & mask) !== (net[i] & mask)) return false;
  }
  return true;
}

/** IPv4 ranges a server must never fetch: private, loopback, link-local/metadata, CGNAT, reserved, multicast. */
const V4_BLOCKED: [[number, number, number, number], number][] = [
  [[0, 0, 0, 0], 8], // "this network"
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16], // link-local, incl. 169.254.169.254 cloud metadata
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved + broadcast
];

function v4Blocked(b: number[]): boolean {
  return V4_BLOCKED.some(([net, bits]) => inV4(b, net, bits));
}

function v6Blocked(b: number[]): boolean {
  const zeroUpTo = (n: number) => b.slice(0, n).every((x) => x === 0);
  if (b.every((x) => x === 0)) return true; // ::
  if (zeroUpTo(15) && b[15] === 1) return true; // ::1
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d → judge the embedded IPv4.
  if (zeroUpTo(10) && b[10] === 0xff && b[11] === 0xff) return v4Blocked(b.slice(12));
  if (zeroUpTo(12)) return v4Blocked(b.slice(12));
  // NAT64 64:ff9b::/96 → embedded IPv4; 64:ff9b:1::/48 (local-use NAT64) → always blocked.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (b.slice(4, 12).every((x) => x === 0)) return v4Blocked(b.slice(12));
    return b[4] === 0 && b[5] === 1;
  }
  // 6to4 2002::/16 carries an IPv4 in bytes 2-5.
  if (b[0] === 0x20 && b[1] === 0x02) return v4Blocked(b.slice(2, 6));
  // Teredo 2001:0::/32 hides an obfuscated IPv4; documentation 2001:db8::/32.
  if (b[0] === 0x20 && b[1] === 0x01 && ((b[2] === 0 && b[3] === 0) || (b[2] === 0x0d && b[3] === 0xb8))) return true;
  if (b[0] === 0x01 && b[1] === 0x00 && b.slice(2, 8).every((x) => x === 0)) return true; // 100::/64 discard
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local (incl. fd00:ec2::254 metadata)
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if (b[0] === 0xff) return true; // multicast
  return false;
}

/** True for an address (IPv4 or IPv6 literal) the server must not connect to. Unparseable → true. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return v4Blocked(v4);
  const v6 = parseIPv6(ip);
  if (v6) return v6Blocked(v6);
  return true;
}

/** Is this hostname (as URL.hostname gives it) an IP literal? */
export function isIpLiteral(hostname: string): boolean {
  return !!parseIPv4(hostname) || (hostname.startsWith("[") && !!parseIPv6(hostname));
}

const LOCAL_NAMES = /(^|\.)(localhost|localdomain|local|internal|home\.arpa)$/;

/**
 * Hostname check that needs no DNS: blocks private/loopback IP literals and local-only names.
 * Hostnames that pass still have to be resolved and checked at connect time (snapshot.ts).
 */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (isIpLiteral(h)) return isPrivateAddress(h);
  if (LOCAL_NAMES.test(h)) return true;
  if (!h.includes(".")) return true; // single-label names resolve via search domains
  return false;
}

// ───────────────────────── Submission URLs ─────────────────────────

/** A public https:// URL with no embedded credentials, or null. */
export function parseHttpsUrl(raw: string): URL | null {
  const s = raw.trim();
  if (!s || s.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (isBlockedHostname(url.hostname)) return null;
  return url;
}

export type GithubRepo = { owner: string; repo: string; url: string };

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** https://github.com/{owner}/{repo} (optionally .git or a trailing slash) → its parts, or null. */
export function parseGithubRepo(raw: string): GithubRepo | null {
  const url = parseHttpsUrl(raw);
  if (!url) return null;
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  if (url.search || url.hash) return null;
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}
