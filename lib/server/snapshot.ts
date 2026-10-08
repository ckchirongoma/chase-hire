import "server-only";
import { createHash } from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isBlockedHostname, isIpLiteral, isPrivateAddress } from "@/lib/work/url";

/**
 * Snapshots of submitted links (docs/01 §5): for each URL the platform records, at submission,
 * the HTTP status, final URL, SHA-256 of the body and the capture time, and stores the HTML in
 * snapshots/{submissionId}/. For SWE Test 1 it records the repo's commit SHA from the GitHub
 * API (lib/server/work resolves it just before the submission is frozen), so grading runs
 * against that commit and later pushes are ignored. Captures more than a minute after the
 * submission are marked late by the caller.
 *
 * Not captured yet: a screenshot of each page (docs/01 §5 allows a Vercel function with
 * Playwright or a screenshot API; neither is in the stack). Only the HTML is stored.
 *
 * SSRF guard: only http(s); hosts that are, or resolve to, private / loopback / link-local /
 * metadata addresses are refused, and the check runs inside the socket's DNS lookup, so a
 * redirect or a DNS rebind cannot reach them either. SNAPSHOT_ALLOW_PRIVATE=1 (tests only)
 * lifts the guard.
 *
 * A snapshot failure never blocks a submission: errors are recorded in the snapshot JSON.
 */

export const SNAPSHOT_TIMEOUT_MS = 10_000;
export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const SNAPSHOT_MAX_REDIRECTS = 5;
const USER_AGENT = "ChaseHireSnapshot/1.0 (+assessment snapshot; contact via the hiring platform)";

export class SsrfError extends Error {
  readonly code = "ESSRF";
}

export function privateAllowed(): boolean {
  return process.env.SNAPSHOT_ALLOW_PRIVATE === "1";
}

export type ResolvedAddress = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

const systemResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * A net/http `lookup` that resolves the host and refuses to connect if ANY address it resolves
 * to is private (unless allowed). Used for every connection the snapshotter makes.
 */
export function guardedLookup(opts: { allowPrivate: boolean; resolve?: Resolver; blockedAddress?: (ip: string) => boolean }): LookupFunction {
  const resolve = opts.resolve ?? systemResolver;
  const blocked = opts.blockedAddress ?? isPrivateAddress;
  const lookup = (
    hostname: string,
    options: dns.LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
  ) => {
    resolve(hostname)
      .then((addresses) => {
        if (!opts.allowPrivate) {
          const bad = addresses.find((a) => blocked(a.address));
          if (bad) throw new SsrfError(`${hostname} resolves to a private or reserved address`);
        }
        const fam = options?.family === 4 || options?.family === 6 ? options.family : 0;
        const list = fam ? addresses.filter((a) => a.family === fam) : addresses;
        if (!list.length) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
        if (options?.all) callback(null, list);
        else callback(null, list[0].address, list[0].family);
      })
      .catch((err: NodeJS.ErrnoException) => callback(err, "", 0));
  };
  return lookup as unknown as LookupFunction;
}

/**
 * Throws SsrfError unless the URL is http(s), has no credentials and a public-looking host
 * (IP literals are judged by `blockedAddress`; names must still pass the connect-time DNS check).
 */
export function assertFetchableUrl(url: URL, allowPrivate = privateAllowed(), blockedAddress: (ip: string) => boolean = isPrivateAddress): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SsrfError(`scheme ${url.protocol} is not allowed`);
  if (url.username || url.password) throw new SsrfError("URLs with credentials are not fetched");
  if (allowPrivate) return;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIpLiteral(host) ? blockedAddress(host.replace(/^\[|\]$/g, "")) : isBlockedHostname(host)) {
    throw new SsrfError(`host ${url.hostname} is not allowed`);
  }
}

export type UrlSnapshot = {
  field: string;
  url: string;
  status: number | null;
  final_url: string | null;
  redirects: string[];
  sha256: string | null;
  bytes: number;
  truncated: boolean;
  content_type: string | null;
  captured_at: string;
  path: string | null;
  error: string | null;
  /** Set by the caller when captured more than a minute after submission. */
  late?: boolean;
};

type HopResult = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean };

function requestOnce(url: URL, signal: AbortSignal, lookup: LookupFunction, maxBytes: number): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
        },
        lookup,
        signal,
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ status, headers: res.headers, body: Buffer.alloc(0), truncated: false });
          return;
        }
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
        let stream: Readable = res;
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());

        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const finish = (truncated: boolean) => {
          if (done) return;
          done = true;
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks, size), truncated });
        };
        stream.on("data", (chunk: Buffer) => {
          if (done) return;
          const room = maxBytes - size;
          if (chunk.length > room) {
            chunks.push(chunk.subarray(0, room));
            size += room;
            finish(true);
            res.destroy();
            if (stream !== res) stream.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        stream.on("end", () => finish(false));
        stream.on("error", (err) => (done ? undefined : reject(err)));
        res.on("error", (err) => (done ? undefined : reject(err)));
        // A connection dropped mid-body must not leave the promise hanging.
        res.on("close", () => (done || res.complete ? undefined : reject(new Error("connection closed before the page finished loading"))));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Fetches one URL (following up to 5 redirects, each re-checked) within 10 s and 2 MB.
 * Never throws: failures come back in `error`.
 */
export async function captureUrl(
  field: string,
  rawUrl: string,
  opts: {
    allowPrivate?: boolean;
    resolve?: Resolver;
    /** Which resolved/literal addresses are refused (default: private, loopback, link-local, metadata, reserved). */
    blockedAddress?: (ip: string) => boolean;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): Promise<UrlSnapshot & { body: Buffer | null }> {
  const allowPrivate = opts.allowPrivate ?? privateAllowed();
  const lookup = guardedLookup({ allowPrivate, resolve: opts.resolve, blockedAddress: opts.blockedAddress });
  const signal = AbortSignal.timeout(opts.timeoutMs ?? SNAPSHOT_TIMEOUT_MS);
  const out: UrlSnapshot & { body: Buffer | null } = {
    field,
    url: rawUrl,
    status: null,
    final_url: null,
    redirects: [],
    sha256: null,
    bytes: 0,
    truncated: false,
    content_type: null,
    captured_at: new Date().toISOString(),
    path: null,
    error: null,
    body: null,
  };
  try {
    let url = new URL(rawUrl);
    for (let hop = 0; ; hop++) {
      assertFetchableUrl(url, allowPrivate, opts.blockedAddress);
      const res = await requestOnce(url, signal, lookup, opts.maxBytes ?? SNAPSHOT_MAX_BYTES);
      out.status = res.status;
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        if (hop >= SNAPSHOT_MAX_REDIRECTS) throw new Error(`more than ${SNAPSHOT_MAX_REDIRECTS} redirects`);
        url = new URL(String(res.headers.location), url);
        out.redirects.push(url.toString());
        continue;
      }
      out.final_url = url.toString();
      out.content_type = res.headers["content-type"] ? String(res.headers["content-type"]).slice(0, 200) : null;
      out.bytes = res.body.length;
      out.truncated = res.truncated;
      out.sha256 = createHash("sha256").update(res.body).digest("hex");
      out.body = res.body;
      break;
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    out.error = (e?.name === "TimeoutError" || e?.name === "AbortError" ? `timed out after ${(opts.timeoutMs ?? SNAPSHOT_TIMEOUT_MS) / 1000} s` : e?.message || String(err)).slice(0, 300);
  }
  out.captured_at = new Date().toISOString();
  return out;
}

export type RepoSnapshot = {
  owner: string;
  repo: string;
  sha: string | null;
  error: string | null;
  resolved_at: string;
  /** Resolved after the freeze (the lookup before it failed or had no time left). */
  after_submission?: boolean;
  /** Resolved more than a minute after submission. */
  late?: boolean;
};

/** The repo's current HEAD commit via GET /repos/{owner}/{repo}/commits/HEAD (GITHUB_TOKEN if set). */
export async function resolveRepoSha(owner: string, repo: string, timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<RepoSnapshot> {
  const base = (process.env.SNAPSHOT_GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const out: RepoSnapshot = { owner, repo, sha: null, error: null, resolved_at: new Date().toISOString() };
  try {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
      "x-github-api-version": "2022-11-28",
    };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/HEAD`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    if (!res.ok) {
      out.error =
        res.status === 404
          ? "GitHub says the repository was not found (it may be private)"
          : res.status === 403 || res.status === 429
            ? `GitHub rate limit or access refused (HTTP ${res.status})`
            : `GitHub API returned HTTP ${res.status}`;
    } else {
      const json = (await res.json()) as { sha?: unknown };
      if (typeof json.sha === "string" && /^[0-9a-f]{40}$/i.test(json.sha)) out.sha = json.sha.toLowerCase();
      else out.error = "GitHub returned no commit SHA";
    }
  } catch (err) {
    const e = err as Error;
    out.error = (e?.name === "TimeoutError" ? "GitHub API timed out" : e?.message || String(err)).slice(0, 300);
  }
  out.resolved_at = new Date().toISOString();
  return out;
}

export type SubmissionSnapshot = {
  captured_at: string;
  /** The submission's freeze time, for judging how late each capture was. */
  submitted_at?: string;
  urls: Record<string, Omit<UrlSnapshot, "url">>;
  repo?: RepoSnapshot;
  errors: number;
};

/**
 * Captures every link of a submission in parallel, stores each body in
 * snapshots/{submissionId}/{n}-{field}.html (as text/plain, so a signed link shows the source
 * instead of running it) and resolves the repo SHA. Never throws.
 */
export async function snapshotSubmission(
  admin: SupabaseClient,
  submissionId: string,
  input: { urls: { field: string; url: string }[]; repo?: { owner: string; repo: string } | null },
): Promise<SubmissionSnapshot> {
  const [captures, repo] = await Promise.all([
    Promise.all(input.urls.map((u) => captureUrl(u.field, u.url))),
    input.repo ? resolveRepoSha(input.repo.owner, input.repo.repo) : Promise.resolve(undefined),
  ]);

  const urls: SubmissionSnapshot["urls"] = {};
  let errors = repo?.error ? 1 : 0;
  await Promise.all(
    captures.map(async (c, i) => {
      const { body, url, ...rest } = c;
      let path: string | null = null;
      if (body && body.length) {
        path = `${submissionId}/${i + 1}-${c.field.replace(/[^a-z0-9_]/gi, "_")}.html`;
        const { error } = await admin.storage
          .from("snapshots")
          .upload(path, body, { contentType: "text/plain; charset=utf-8", upsert: true });
        if (error) {
          rest.error = rest.error ?? `could not store the snapshot: ${error.message}`.slice(0, 300);
          path = null;
        }
      }
      if (rest.error) errors++;
      urls[url] = { ...rest, path };
    }),
  );
  return { captured_at: new Date().toISOString(), urls, ...(repo ? { repo } : {}), errors };
}
