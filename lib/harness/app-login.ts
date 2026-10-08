import { decodeJwt } from "./jwt";

/**
 * Signs in through the deployed app's own login page, the way a browser without JavaScript
 * does: GET the page, fill the form that has a password field (keeping its hidden inputs, e.g.
 * a Next.js server action's $ACTION_* fields or a CSRF token), POST it, and keep the cookies the
 * app sets. Used when the bundle carries no publishable key (apps that keep Supabase
 * server-side), so the harness can still crawl signed-in pages (U2) and call the app's routes
 * as each test user (U4–U7). With an @supabase/ssr session cookie the access token is read from
 * it too, so REST probes work once the project's publishable key is known.
 *
 * The parsing here is pure (unit-tested); signInWithForm does the requests.
 */

export interface LoginFormSpec {
  action: string;
  method: "POST" | "GET";
  multipart: boolean;
  /** Every successful control except the email and password, in document order. */
  fields: [string, string][];
  emailField: string;
  passwordField: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Attributes of one start tag, lower-cased names, entity-decoded values. */
export function tagAttributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const inner = tag.replace(/^<\s*[a-z0-9-]+/i, "").replace(/\/?>$/, "");
  for (const m of inner.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

const EMAIL_NAME = /e-?mail|user(?:name)?|login|identifier|account/i;

/** Login forms on a page: forms with a password input and an email/username input. */
export function parseLoginForms(html: string, pageUrl: string): LoginFormSpec[] {
  const out: LoginFormSpec[] = [];
  for (const fm of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi)) {
    const formHtml = fm[0];
    const formTag = formHtml.match(/^<form\b[^>]*>/i)![0];
    const fa = tagAttributes(formTag);
    const controls = [...formHtml.matchAll(/<(input|button|textarea|select)\b[^>]*>/gi)].map((m) => ({ kind: m[1].toLowerCase(), a: tagAttributes(m[0]) }));
    const inputs = controls.filter((c) => c.kind === "input");
    const password = inputs.find((c) => (c.a.type ?? "").toLowerCase() === "password" && c.a.name);
    if (!password) continue;
    const email =
      inputs.find((c) => (c.a.type ?? "").toLowerCase() === "email" && c.a.name) ??
      inputs.find((c) => ["text", ""].includes((c.a.type ?? "").toLowerCase()) && c.a.name && (EMAIL_NAME.test(c.a.name) || EMAIL_NAME.test(c.a.id ?? "") || EMAIL_NAME.test(c.a.autocomplete ?? "")));
    if (!email) continue;
    const fields: [string, string][] = [];
    let submitAdded = false;
    for (const c of controls) {
      const name = c.a.name;
      if (!name || name === email.a.name || name === password.a.name || "disabled" in c.a) continue;
      const type = (c.a.type ?? (c.kind === "button" ? "submit" : "text")).toLowerCase();
      if (c.kind === "input" && ["file", "image", "reset", "button"].includes(type)) continue;
      if ((c.kind === "input" || c.kind === "button") && type === "submit") {
        // Only the button that "was clicked" (the first named one) is submitted.
        if (!submitAdded) fields.push([name, c.a.value ?? ""]);
        submitAdded = true;
        continue;
      }
      if (c.kind === "button") continue;
      if (c.kind === "input" && ["checkbox", "radio"].includes(type) && !("checked" in c.a)) continue;
      if (c.kind === "input" && ["checkbox", "radio"].includes(type)) fields.push([name, c.a.value ?? "on"]);
      else if (c.kind === "input") fields.push([name, c.a.value ?? ""]);
    }
    let action: string;
    try {
      action = new URL(fa.action || pageUrl, pageUrl).toString();
    } catch {
      continue;
    }
    out.push({
      action,
      method: (fa.method ?? "get").toUpperCase() === "POST" ? "POST" : "GET",
      multipart: /multipart\/form-data/i.test(fa.enctype ?? ""),
      fields,
      emailField: email.a.name,
      passwordField: password.a.name,
    });
  }
  return out;
}

// ───────────────────────── Cookies ─────────────────────────

/** Applies Set-Cookie headers to a jar (deleted / expired cookies are removed). */
export function applySetCookies(jar: Map<string, string>, setCookies: readonly string[], now = Date.now()): void {
  for (const sc of setCookies) {
    const [pair, ...attrs] = sc.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const maxAge = attrs.map((a) => a.trim().match(/^max-age=(-?\d+)/i)?.[1]).find((x) => x !== undefined);
    const expires = attrs.map((a) => a.trim().match(/^expires=(.+)$/i)?.[1]).find((x) => x !== undefined);
    const expired = (maxAge !== undefined && Number(maxAge) <= 0) || (expires !== undefined && Date.parse(expires) <= now);
    if (!value || expired) jar.delete(name);
    else jar.set(name, value);
  }
}

export const cookieHeaderOf = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

const AUTH_COOKIE = /^(sb-[A-Za-z0-9_-]+-auth-token)(?:\.(\d+))?$/;

export interface CookieSession {
  accessToken: string;
  userId: string;
  email: string | null;
  raw: Record<string, unknown>;
  /** The Supabase project URL from the access token's iss claim, if it has one. */
  issuerOrigin: string | null;
}

/** The Supabase session stored by @supabase/ssr (or the older auth helpers) in the jar. */
export function sessionFromCookies(jar: Map<string, string>): CookieSession | null {
  type Group = { whole?: string; parts: Map<number, string> };
  const groups = new Map<string, Group>();
  for (const [name, value] of jar) {
    const m = name.match(AUTH_COOKIE);
    if (!m) continue;
    const g: Group = groups.get(m[1]) ?? { parts: new Map<number, string>() };
    if (m[2] === undefined) g.whole = value;
    else g.parts.set(Number(m[2]), value);
    groups.set(m[1], g);
  }
  for (const g of groups.values()) {
    let value = g.whole;
    if (!value && g.parts.size) {
      const chunks: string[] = [];
      for (let i = 0; g.parts.has(i); i++) chunks.push(g.parts.get(i)!);
      value = chunks.join("");
    }
    if (!value) continue;
    let text: string;
    try {
      text = value.startsWith("base64-") ? Buffer.from(value.slice(7), "base64url").toString("utf8") : decodeURIComponent(value);
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    // @supabase/ssr: the session object; old auth helpers: [access_token, refresh_token, …].
    const obj: Record<string, unknown> | null = Array.isArray(parsed) ? { access_token: parsed[0], refresh_token: parsed[1] } : (parsed as Record<string, unknown> | null);
    const token = obj && typeof obj.access_token === "string" ? obj.access_token : null;
    if (!token) continue;
    const claims = decodeJwt(token);
    const user = (obj?.user ?? null) as { id?: unknown; email?: unknown } | null;
    const userId = typeof user?.id === "string" ? user.id : typeof claims?.sub === "string" ? claims.sub : null;
    if (!userId) continue;
    let issuerOrigin: string | null = null;
    try {
      issuerOrigin = typeof claims?.iss === "string" && /\/auth\/v1\/?$/.test(claims.iss) ? new URL(claims.iss).origin : null;
    } catch {
      issuerOrigin = null;
    }
    const email = typeof user?.email === "string" ? user.email : typeof claims?.email === "string" ? claims.email : null;
    return { accessToken: token, userId, email, raw: obj ?? {}, issuerOrigin };
  }
  return null;
}

/** Does a redirect target look like "back to the login page" (a failed sign-in)? */
export const looksLikeLoginPage = (location: string) => /log-?in|sign-?in|auth|error/i.test(location);
