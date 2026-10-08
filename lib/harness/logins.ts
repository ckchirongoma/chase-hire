import { findJwts } from "./jwt";

/**
 * Parses the test logins a SWE Test 1 candidate submits (docs/16 "Logins the candidate submits"):
 *
 *   agent: email / password
 *   agent: email / password
 *   manager: email / password
 *
 * Candidates do not always follow the format, so this also reads bullets, markdown emphasis and
 * code spans, tables, "Email: … Password: …" pairs split over two lines, other separators
 * (/, |, comma, tab, " - ") and role headings on their own line ("Agent A", "Manager (Lerato)").
 * Passwords are never logged or stored by the harness: only the emails go into evidence.
 */

export type LoginRole = "agent" | "manager";
export interface Login {
  role: LoginRole;
  email: string;
  password: string;
  /** 1-based line the email was found on. */
  line: number;
}
export interface ParsedLogins {
  agents: Login[];
  manager: Login | null;
  /** Problems a reviewer should know about (missing roles or passwords, assumed roles). */
  problems: string[];
  /**
   * The Supabase project URL and publishable key, when the candidate wrote them alongside the
   * logins (apps that keep Supabase server-side ship neither in their bundle). Both are public
   * by design.
   */
  supabaseUrl?: string | null;
  publishableKey?: string | null;
}

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const MANAGER_WORD = /\b(manager|mgr|supervisor|team\s*lead|admin(?:istrator)?|gm)\b/i;
const AGENT_WORD = /\b(agents?|sales\s*agent|user\s*[ab12])\b/i;
/** "Password: x", "pw = x" or "Password x" (a bare "pw-…" is a password, not a label). */
const PASSWORD_LABEL = /^(?:(?:password|passwd|pass|pwd|pw)\s*[:=]\s*|password\s+)/i;

function roleIn(text: string): LoginRole | null {
  if (MANAGER_WORD.test(text)) return "manager";
  if (AGENT_WORD.test(text)) return "agent";
  return null;
}

/** Strips markdown/table decoration and invisible characters, keeping the line structure. */
function normalise(raw: string): string[] {
  return raw
    .replace(/[​-‏‪-‮⁠-⁤﻿]/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) =>
      l
        .replace(/\*\*|__/g, "")
        .replace(/`/g, "")
        .replace(/^\s*(?:[-*•>]|\d+[.)])\s+/, "")
        .trim(),
    );
}

function unquote(s: string): string {
  const t = s.trim();
  const m = t.match(/^(["'“‘])(.*)(["'”’])$/);
  return m ? m[2] : t;
}

/** The password written after the email on the same line, if any. */
function passwordAfter(rest: string): string | null {
  let r = rest;
  // Table cells: "| email | password |"
  if (/^\s*\|/.test(r)) {
    const cells = r.split("|").map((c) => c.trim());
    const cell = cells.find((c, i) => i > 0 && c.length > 0);
    return cell ? unquote(cell.replace(PASSWORD_LABEL, "")) || null : null;
  }
  r = r.replace(/^\s*(?:[/|,;\t]|\s-\s|\s–\s|\s—\s|:)\s*/, " ").trim();
  const labelled = r.match(/^\(\s*(?:(?:password|passwd|pass|pwd|pw)\s*[:=]|password\s)\s*(.*?)\s*\)$/i);
  r = labelled ? labelled[1] : r.replace(PASSWORD_LABEL, "").trim();
  if (!r) return null;
  // "pw | note" in a table or a trailing comment after two spaces + "(...)"
  r = r.replace(/\s+\|\s*$/, "").trim();
  return unquote(r) || null;
}

export function parseTestLogins(raw: string | null | undefined): ParsedLogins {
  const out: ParsedLogins = { agents: [], manager: null, problems: [] };
  if (!raw || !raw.trim()) {
    out.problems.push("no test logins were submitted");
    return out;
  }
  const lines = normalise(raw);
  const sbUrl = raw.match(/https?:\/\/[A-Za-z0-9-]+\.supabase\.(?:co|in)\b/) ?? raw.match(/supabase[^\n]*?(https?:\/\/[^\s/`'"<>|]+)/i);
  out.supabaseUrl = sbUrl ? (sbUrl[1] ?? sbUrl[0]) : null;
  // A legacy anon JWT is accepted; anything with more privileges is never used as the key.
  const jwts = findJwts(raw);
  if (jwts.some((j) => j.role !== "anon")) out.problems.push("a non-anon key (e.g. service_role) was pasted into the test logins: it is not used");
  out.publishableKey = raw.match(/\bsb_publishable_[A-Za-z0-9_-]{8,}/)?.[0] ?? jwts.find((j) => j.role === "anon")?.token ?? null;
  const found: { role: LoginRole | null; email: string; password: string | null; line: number }[] = [];
  let headingRole: LoginRole | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const m = line.match(EMAIL);
    if (!m || m.index === undefined) {
      // A heading such as "Agent A" or "Manager login:" sets the role for what follows.
      const r = roleIn(line);
      if (r && !PASSWORD_LABEL.test(line)) headingRole = r;
      // "Password: x" on its own line completes the previous entry.
      if (PASSWORD_LABEL.test(line) && found.length && found[found.length - 1].password === null) {
        const pw = unquote(line.replace(PASSWORD_LABEL, ""));
        if (pw) found[found.length - 1].password = pw;
      }
      continue;
    }
    const before = line.slice(0, m.index);
    const after = line.slice(m.index + m[0].length);
    const role = roleIn(before) ?? headingRole;
    let password = passwordAfter(after);
    // Email on one line, the password on the next ("Email: x" / "Password: y").
    if (!password && i + 1 < lines.length && PASSWORD_LABEL.test(lines[i + 1]) && !EMAIL.test(lines[i + 1])) {
      password = unquote(lines[i + 1].replace(PASSWORD_LABEL, "")) || null;
      i++;
    }
    found.push({ role, email: m[0].toLowerCase(), password, line: i + 1 });
  }

  if (!found.length) {
    out.problems.push("no email addresses found in the test logins");
    return out;
  }
  // No roles anywhere but exactly three logins: take the documented order (agent, agent, manager).
  if (found.every((f) => f.role === null) && found.length === 3) {
    found[0].role = "agent";
    found[1].role = "agent";
    found[2].role = "manager";
    out.problems.push("no roles were written: assumed the documented order (agent, agent, manager)");
  }
  for (const f of found) {
    if (!f.password) {
      out.problems.push(`no password found for ${f.email}`);
      continue;
    }
    if (f.role === "manager") {
      if (!out.manager) out.manager = { role: "manager", email: f.email, password: f.password, line: f.line };
      else out.problems.push(`more than one manager login: using ${out.manager.email}`);
    } else if (f.role === "agent") {
      if (!out.agents.some((a) => a.email === f.email)) out.agents.push({ role: "agent", email: f.email, password: f.password, line: f.line });
    } else out.problems.push(`no role written for ${f.email}`);
  }
  if (out.agents.length < 2) out.problems.push(`expected two agent logins, found ${out.agents.length}`);
  if (!out.manager) out.problems.push("no manager login found");
  return out;
}

/** Evidence-safe view: emails and roles only. */
export function describeLogins(p: ParsedLogins): { agents: string[]; manager: string | null; problems: string[]; supabase_url: string | null; publishable_key_given: boolean } {
  return { agents: p.agents.map((a) => a.email), manager: p.manager?.email ?? null, problems: p.problems, supabase_url: p.supabaseUrl ?? null, publishable_key_given: !!p.publishableKey };
}
