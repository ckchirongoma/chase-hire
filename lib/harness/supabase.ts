import "server-only";
import { describeError, type Http, type HttpResponse } from "./http";

/**
 * Talks to the candidate's Supabase project the way their front end does: PostgREST under
 * /rest/v1 and GoTrue under /auth/v1, with the publishable (anon) key from their bundle, and as
 * their test users after a password sign-in. Also builds the @supabase/ssr session cookie so the
 * app's own routes see the same user.
 */

export interface Session {
  accessToken: string;
  userId: string;
  email: string;
  /** The token endpoint's JSON (what @supabase/ssr stores in its cookie). */
  raw: Record<string, unknown>;
  /**
   * The cookies the app itself set when the user signed in through its login form (no-JS
   * fallback when the bundle carries no publishable key). Sent as-is to the app's routes.
   */
  cookieHeader?: string;
  via?: "supabase-auth" | "app-login-form";
}

export class ProbeError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export interface RestResult<T = Record<string, unknown>> {
  status: number;
  rows: T[] | null;
  /** From Content-Range when count was requested. */
  count: number | null;
  /** PostgREST error code (e.g. 42501, 23514, PGRST205) when present. */
  code: string | null;
  message: string | null;
  /** PostgREST's hint (a trigger's `using hint = …`), when present. */
  hint: string | null;
  bodySnippet: string;
}

export type Filters = Record<string, string>;

/** PostgREST `in.(…)` with every value quoted (handles +, commas, slashes and spaces). */
export function inList(values: readonly (string | number)[]): string {
  return `in.(${values.map((v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")})`;
}

function parseCount(h: string | undefined): number | null {
  const m = h?.match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export class SupabaseProbe {
  readonly url: string;
  constructor(
    readonly http: Http,
    supabaseUrl: string,
    readonly key: string,
  ) {
    this.url = supabaseUrl.replace(/\/+$/, "");
  }

  private headers(session?: Session | null, extra: Record<string, string> = {}): Record<string, string> {
    return { apikey: this.key, authorization: `Bearer ${session?.accessToken ?? this.key}`, accept: "application/json", ...extra };
  }

  /** GET /auth/v1/settings: confirms this is a Supabase project that accepts the key. */
  async looksLikeSupabase(): Promise<boolean> {
    try {
      const res = await this.http.request(`${this.url}/auth/v1/settings`, { headers: { apikey: this.key }, timeoutMs: 6000, maxBytes: 64_000 });
      const j = res.json<Record<string, unknown>>();
      return res.status === 200 && !!j && typeof j === "object" && ("external" in j || "disable_signup" in j);
    } catch {
      return false;
    }
  }

  async signIn(email: string, password: string): Promise<Session> {
    let res: HttpResponse;
    try {
      res = await this.http.request(`${this.url}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: this.key, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email, password }),
        timeoutMs: 12_000,
        maxBytes: 256_000,
      });
    } catch (err) {
      throw new ProbeError(`sign-in request failed: ${describeError(err)}`);
    }
    const j = res.json<Record<string, unknown>>();
    const user = (j?.user ?? null) as { id?: unknown; email?: unknown } | null;
    if (res.status !== 200 || !j || typeof j.access_token !== "string" || !user || typeof user.id !== "string") {
      const msg = typeof j?.error_description === "string" ? j.error_description : typeof j?.msg === "string" ? j.msg : typeof j?.message === "string" ? j.message : `HTTP ${res.status}`;
      throw new ProbeError(`sign-in as ${email} failed: ${String(msg).slice(0, 160)}`, res.status);
    }
    const raw = { ...j };
    delete raw.weak_password;
    return { accessToken: j.access_token, userId: user.id, email: typeof user.email === "string" ? user.email : email, raw, via: "supabase-auth" };
  }

  private async rest<T>(method: string, table: string, params: Filters, opts: { session?: Session | null; body?: unknown; prefer?: string; count?: boolean; timeoutMs?: number }): Promise<RestResult<T>> {
    const qs = new URLSearchParams(params).toString();
    const prefer = [opts.prefer, opts.count ? "count=exact" : null].filter(Boolean).join(",");
    const res = await this.http.request(`${this.url}/rest/v1/${encodeURIComponent(table)}${qs ? `?${qs}` : ""}`, {
      method,
      headers: this.headers(opts.session, {
        ...(prefer ? { prefer } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      }),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      timeoutMs: opts.timeoutMs ?? 15_000,
      maxBytes: 4 * 1024 * 1024,
    });
    const text = res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const err = !Array.isArray(json) && json && typeof json === "object" ? (json as Record<string, unknown>) : null;
    return {
      status: res.status,
      rows: Array.isArray(json) ? (json as T[]) : null,
      count: parseCount(res.headers["content-range"]),
      code: err && typeof err.code === "string" ? err.code : null,
      message: err && typeof err.message === "string" ? err.message.slice(0, 300) : null,
      hint: err && typeof err.hint === "string" ? err.hint.slice(0, 200) : null,
      bodySnippet: text.slice(0, 300),
    };
  }

  select<T = Record<string, unknown>>(table: string, params: Filters, session?: Session | null, opts: { count?: boolean } = {}) {
    return this.rest<T>("GET", table, params, { session, count: opts.count });
  }

  /** Row count via Content-Range (limit 1). null when the table can't be read. */
  async count(table: string, filters: Filters, session?: Session | null): Promise<RestResult & { total: number | null }> {
    const r = await this.rest<Record<string, unknown>>("GET", table, { select: "id", limit: "1", ...filters }, { session, count: true });
    return { ...r, total: r.status >= 200 && r.status < 300 ? (r.count ?? r.rows?.length ?? null) : null };
  }

  /** Every row (paged by 1000, at most `max`). */
  async selectAll<T = Record<string, unknown>>(table: string, params: Filters, session?: Session | null, max = 5000): Promise<RestResult<T>> {
    const all: T[] = [];
    let last: RestResult<T> | null = null;
    for (let offset = 0; offset < max; offset += 1000) {
      last = await this.rest<T>("GET", table, { ...params, limit: String(Math.min(1000, max - offset)), offset: String(offset) }, { session });
      if (!last.rows) return last;
      all.push(...last.rows);
      if (last.rows.length < 1000) break;
    }
    return { ...(last as RestResult<T>), rows: all };
  }

  insert(table: string, body: unknown, session?: Session | null, prefer = "return=minimal") {
    return this.rest("POST", table, {}, { session, body, prefer });
  }
}

/** Is a REST status a refusal (auth, permission, RLS, missing table) rather than data? */
export const refused = (status: number) => status === 401 || status === 403 || status === 404;

// ───────────────────────── App session (cookies) ─────────────────────────

const MAX_CHUNK = 3180;

/** sb-<ref>-auth-token: the storage key supabase-js derives from the project URL. */
export function authCookieName(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
}

function base64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The Cookie header @supabase/ssr (≥0.4) reads for this session: "base64-" + base64url(JSON),
 * split into name.0, name.1 … chunks above 3180 characters.
 */
export function sessionCookieHeader(supabaseUrl: string, session: Session): string {
  const name = authCookieName(supabaseUrl);
  const value = `base64-${base64url(JSON.stringify(session.raw))}`;
  if (value.length <= MAX_CHUNK) return `${name}=${value}`;
  const parts: string[] = [];
  for (let i = 0, n = 0; i < value.length; i += MAX_CHUNK, n++) parts.push(`${name}.${n}=${value.slice(i, i + MAX_CHUNK)}`);
  return parts.join("; ");
}

/**
 * Headers that authenticate an app route as this user (cookie for SSR apps, bearer for APIs):
 * the app's own cookies when it set them, else the @supabase/ssr cookie built for the project.
 */
export function appAuthHeaders(supabaseUrl: string | null, session: Session): Record<string, string> {
  const cookie = session.cookieHeader ?? (supabaseUrl ? sessionCookieHeader(supabaseUrl, session) : null);
  return { ...(cookie ? { cookie } : {}), authorization: `Bearer ${session.accessToken}` };
}
