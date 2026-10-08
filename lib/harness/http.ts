import "server-only";
import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { Readable } from "node:stream";
import zlib from "node:zlib";
import { assertFetchableUrl, guardedLookup, privateAllowed, SsrfError } from "@/lib/server/snapshot";

/**
 * Outbound HTTP for the URL and import checks. Every request to a candidate-controlled host
 * (their deployment, the Supabase URL in their bundle) and to the MDN Observatory goes through
 * the snapshotter's SSRF guard: http(s) only, no credentials in URLs, private / loopback /
 * metadata addresses refused at DNS time, every redirect hop re-checked
 * (SNAPSHOT_ALLOW_PRIVATE=1 lifts it, for tests only).
 *
 * Each request has its own timeout, capped by the run's Budget so a whole run stays inside the
 * route's maxDuration. Bodies are capped (default 2 MB) and decompressed.
 */

export { SsrfError };

export class BudgetExceeded extends Error {
  readonly code = "EBUDGET";
  constructor() {
    super("the harness ran out of time for this run");
  }
}

export class Budget {
  readonly deadline: number;
  constructor(readonly totalMs: number) {
    this.deadline = Date.now() + totalMs;
  }
  remaining(): number {
    return this.deadline - Date.now();
  }
  /** Throws BudgetExceeded when less than `minMs` is left. */
  ensure(minMs = 500): void {
    if (this.remaining() < minMs) throw new BudgetExceeded();
  }
}

export interface HttpResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  /** Raw Set-Cookie values (the flattened header joins them with ", ", which Expires breaks). */
  setCookies: string[];
  body: Buffer;
  truncated: boolean;
  ms: number;
  redirects: string[];
  text(): string;
  json<T = unknown>(): T | null;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Redirects to follow (re-checked by the SSRF guard each hop). Default 0: return the 3xx. */
  followRedirects?: number;
}

export interface Http {
  request(url: string | URL, opts?: RequestOptions): Promise<HttpResponse>;
  readonly budget: Budget;
}

const USER_AGENT = "ChaseHireVerify/1.0 (+SWE Test 1 verification harness; contact via the hiring platform)";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function flatHeaders(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  return out;
}

function once(
  url: URL,
  opts: { method: string; headers: Record<string, string>; body?: Buffer; timeoutMs: number; maxBytes: number; allowPrivate: boolean },
): Promise<{ status: number; headers: Record<string, string>; setCookies: string[]; body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const signal = AbortSignal.timeout(opts.timeoutMs);
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: opts.method,
        headers: { "user-agent": USER_AGENT, "accept-encoding": "gzip, deflate, br", ...opts.headers, ...(opts.body ? { "content-length": String(opts.body.length) } : {}) },
        lookup: guardedLookup({ allowPrivate: opts.allowPrivate }),
        signal,
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
        let stream: Readable = res;
        if (opts.method !== "HEAD") {
          if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
          else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
          else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const finish = (truncated: boolean) => {
          if (done) return;
          done = true;
          resolve({ status, headers: flatHeaders(res.headers), setCookies: res.headers["set-cookie"] ?? [], body: Buffer.concat(chunks, size), truncated });
        };
        stream.on("data", (chunk: Buffer) => {
          if (done) return;
          const room = opts.maxBytes - size;
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
        res.on("close", () => (done || res.complete ? undefined : reject(new Error("connection closed before the response finished"))));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export function describeError(err: unknown, timeoutMs?: number): string {
  const e = err as NodeJS.ErrnoException;
  if (e instanceof SsrfError) return `blocked by the SSRF guard: ${e.message}`;
  if (e instanceof BudgetExceeded) return e.message;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return `timed out${timeoutMs ? ` after ${Math.round(timeoutMs / 1000)} s` : ""}`;
  return (e?.code ? `${e.code}: ` : "") + (e?.message || String(err)).slice(0, 200);
}

const CREDENTIAL_HEADERS = new Set(["cookie", "authorization", "apikey", "proxy-authorization", "x-api-key"]);

/**
 * Headers for the next redirect hop (always a GET without a body): the body's headers go, and on
 * a cross-origin hop so do the credentials (the test user's session cookie and token, the
 * publishable key), as browsers and fetch do.
 */
export function redirectHeaders(headers: Record<string, string>, from: URL, to: URL): Record<string, string> {
  const crossOrigin = from.origin !== to.origin;
  return Object.fromEntries(
    Object.entries(headers).filter(([k]) => {
      const name = k.toLowerCase();
      if (name === "content-type" || name === "content-length") return false;
      return !(crossOrigin && CREDENTIAL_HEADERS.has(name));
    }),
  );
}

/** A guarded HTTP client bound to one run's budget. */
export function createHttp(opts: { budget: Budget; allowPrivate?: boolean; defaultTimeoutMs?: number }): Http {
  const allowPrivate = opts.allowPrivate ?? privateAllowed();
  return {
    budget: opts.budget,
    async request(target, ro = {}) {
      let url = typeof target === "string" ? new URL(target) : new URL(target.toString());
      const method = (ro.method ?? "GET").toUpperCase();
      const body = ro.body === undefined ? undefined : Buffer.isBuffer(ro.body) ? ro.body : Buffer.from(ro.body);
      const redirects: string[] = [];
      const started = Date.now();
      let headers = ro.headers ?? {};
      for (let hop = 0; ; hop++) {
        opts.budget.ensure();
        assertFetchableUrl(url, allowPrivate);
        const timeoutMs = Math.max(250, Math.min(ro.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, opts.budget.remaining() - 250));
        const res = await once(url, { method: hop === 0 ? method : "GET", headers, body: hop === 0 ? body : undefined, timeoutMs, maxBytes: ro.maxBytes ?? DEFAULT_MAX_BYTES, allowPrivate });
        if (res.status >= 300 && res.status < 400 && res.headers.location && hop < (ro.followRedirects ?? 0)) {
          const next = new URL(res.headers.location, url);
          headers = redirectHeaders(headers, url, next);
          url = next;
          redirects.push(url.toString());
          continue;
        }
        const final = url.toString();
        return {
          url: final,
          status: res.status,
          headers: res.headers,
          setCookies: res.setCookies,
          body: res.body,
          truncated: res.truncated,
          ms: Date.now() - started,
          redirects,
          text: () => res.body.toString("utf8"),
          json<T>() {
            try {
              return JSON.parse(res.body.toString("utf8")) as T;
            } catch {
              return null;
            }
          },
        };
      }
    },
  };
}

/** multipart/form-data with one file field. */
export function multipartFile(field: string, filename: string, contentType: string, data: Buffer): { body: Buffer; contentType: string } {
  const boundary = `----chasehire${randomBytes(12).toString("hex")}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename.replace(/["\r\n]/g, "_")}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tailBuf = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, data, tailBuf]), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** multipart/form-data with text fields only (a no-JavaScript form post). */
export function multipartFields(fields: readonly (readonly [string, string])[]): { body: Buffer; contentType: string } {
  const boundary = `----chasehire${randomBytes(12).toString("hex")}`;
  const clean = (s: string) => s.replace(/["\r\n]/g, "_");
  const parts = fields.map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${clean(name)}"\r\n\r\n${value}\r\n`));
  return { body: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Runs async tasks with a concurrency cap, preserving order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
