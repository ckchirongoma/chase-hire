import "server-only";
import { PRICE_PLANS } from "@/lib/synth/base";
import { normaliseCompanyName } from "@/lib/synth/names";
import { fail, inconclusive, pass, snippet, type CheckKey, type CheckResult, type Evidence } from "./checks";
import type { HarnessExpected } from "./expected";
import { crawlPublic, findSupabase, newFrontEnd, signInAll, type SupabaseTarget } from "./frontend";
import { BudgetExceeded, describeError, multipartFile, SsrfError, type Http } from "./http";
import { describeLogins, type ParsedLogins } from "./logins";
import { appAuthHeaders, inList, type Session } from "./supabase";
import { PROBE_NOTE } from "./url-checks";

/**
 * Month-2 import checks M1–M7 and data checks D-a..D-c (docs/07 "Month-2 import test"), as the
 * candidate's manager login. This MUTATES the candidate's deployed database: it uploads the
 * held-back month-2 file twice and the drift file once, and may log one labelled interaction per
 * sentinel customer so M2 has history to follow. The admin confirms before it runs.
 *
 * If the deployment already holds month 2 (an earlier run), M1–M5 cannot be judged against a
 * month-1 baseline: they are skipped (no rows written, earlier results stand) and only M6, M7 and
 * the data checks run.
 */

export const IMPORT_FILE_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SAMPLE = 25;

export interface ImportCheckInput {
  http: Http;
  deployedUrl: string;
  logins: ParsedLogins;
  expected: HarnessExpected;
  files: { month2: Buffer; drift: Buffer; month2Name?: string; driftName?: string };
  overrides?: { supabaseUrl?: string | null; anonKey?: string | null };
  uploadTimeoutMs?: number;
  now?: Date;
}

type Row = Record<string, unknown>;

interface State {
  customers: number | null;
  lines: number | null;
  activeLines: number | null;
  sentinels: { key: string; id: string | null }[];
  interactions: { id: string; customer_id: string }[] | null;
  sample: { changed: Row[] | null; removed: Row[] | null; added: Row[] | null };
}

interface Upload {
  status: number | null;
  ms: number;
  body: string;
  json: unknown;
  error: string | null;
  startedAt: number;
}

const is2xx = (s: number | null) => s !== null && s >= 200 && s < 300;

function msisdnOf(r: Row): string | null {
  for (const k of ["msisdn_e164", "msisdn", "phone_e164", "phone", "number"]) if (typeof r[k] === "string" || typeof r[k] === "number") return String(r[k]);
  return null;
}

function pickKey(r: Row | undefined, preferred: string, re: RegExp): string | null {
  if (!r) return null;
  if (preferred in r) return preferred;
  return Object.keys(r).find((k) => re.test(k)) ?? null;
}

class Probe {
  constructor(
    readonly sb: SupabaseTarget,
    readonly s: Session,
  ) {}

  async count(table: string, filters: Record<string, string> = {}): Promise<number | null> {
    return (await this.sb.probe.count(table, filters, this.s)).total;
  }

  async linesFor(msisdns: string[]): Promise<Row[] | null> {
    if (!msisdns.length) return [];
    const r = await this.sb.probe.select("lines", { select: "*", msisdn_e164: inList(msisdns), limit: "500" }, this.s);
    return r.rows;
  }

  async sentinelIds(expected: HarnessExpected): Promise<{ key: string; id: string | null }[]> {
    const regs = expected.sentinels.map((s) => s.reg_no).filter((x): x is string => !!x);
    const byReg = regs.length ? await this.sb.probe.select("customers", { select: "id,reg_no,normalised_name,legal_name", reg_no: inList(regs) }, this.s) : null;
    const names = expected.sentinels.map((s) => normaliseCompanyName(s.name));
    const missing = expected.sentinels.filter((s) => !(byReg?.rows ?? []).some((r) => r.reg_no === s.reg_no));
    const byName = missing.length ? await this.sb.probe.select("customers", { select: "id,reg_no,normalised_name,legal_name", normalised_name: inList(names) }, this.s) : null;
    return expected.sentinels.map((s) => {
      const hit =
        (byReg?.rows ?? []).find((r) => r.reg_no === s.reg_no) ??
        (byName?.rows ?? []).find((r) => normaliseCompanyName(String(r.normalised_name ?? r.legal_name ?? "")) === normaliseCompanyName(s.name));
      return { key: s.reg_no ?? s.name, id: hit ? String(hit.id) : null };
    });
  }

  async interactionsOf(customerIds: string[]): Promise<{ id: string; customer_id: string }[] | null> {
    if (!customerIds.length) return [];
    const r = await this.sb.probe.select("interactions", { select: "id,customer_id", customer_id: inList(customerIds), limit: "1000" }, this.s);
    return r.rows ? r.rows.map((x) => ({ id: String(x.id), customer_id: String(x.customer_id) })) : null;
  }
}

async function snapshot(p: Probe, expected: HarnessExpected): Promise<State> {
  const changed = expected.month2.changed.slice(0, SAMPLE).map((c) => c.msisdn_e164);
  const removed = expected.month2.removed_msisdns.slice(0, SAMPLE);
  const added = expected.month2.new_msisdns.slice(0, SAMPLE);
  const [customers, lines, activeLines, sentinels, c, r, a] = await Promise.all([
    p.count("customers"),
    p.count("lines"),
    p.count("lines", { active: "is.true" }),
    p.sentinelIds(expected),
    p.linesFor(changed),
    p.linesFor(removed),
    p.linesFor(added),
  ]);
  const sentinelIds = sentinels.map((s) => s.id).filter((x): x is string => !!x);
  return { customers, lines, activeLines, sentinels, interactions: await p.interactionsOf(sentinelIds), sample: { changed: c, removed: r, added: a } };
}

async function upload(http: Http, base: URL, sb: SupabaseTarget, s: Session, name: string, data: Buffer, timeoutMs: number): Promise<Upload> {
  const startedAt = Date.now();
  const mp = multipartFile("file", name, IMPORT_FILE_TYPE, data);
  try {
    const res = await http.request(new URL("/api/import", base), {
      method: "POST",
      body: mp.body,
      headers: { "content-type": mp.contentType, accept: "application/json", ...appAuthHeaders(sb.url, s) },
      timeoutMs,
      maxBytes: 1024 * 1024,
    });
    return { status: res.status, ms: res.ms, body: res.text(), json: res.json(), error: null, startedAt };
  } catch (err) {
    if (err instanceof BudgetExceeded || err instanceof SsrfError) throw err;
    return { status: null, ms: Date.now() - startedAt, body: "", json: null, error: describeError(err, timeoutMs), startedAt };
  }
}

const uploadEvidence = (u: Upload) => ({ status: u.status, ms: u.ms, error: u.error, body: snippet(u.body, 400) });

/** Comparable view of a line row: identity plus the fields the import may change. */
function lineView(r: Row): string {
  const end = r[pickKey(r, "contract_end_date", /end/i) ?? ""];
  const plan = r[pickKey(r, "priceplan", /plan/i) ?? ""];
  return JSON.stringify([r.id, msisdnOf(r), plan ?? null, end ?? null, r.active ?? null, r.ported_out_at ?? null, r.contract_status ?? null]);
}

function stateDiff(a: State, b: State): string[] {
  const diffs: string[] = [];
  if (a.customers !== b.customers) diffs.push(`customers ${a.customers} → ${b.customers}`);
  if (a.lines !== b.lines) diffs.push(`lines ${a.lines} → ${b.lines}`);
  if (a.activeLines !== b.activeLines) diffs.push(`active lines ${a.activeLines} → ${b.activeLines}`);
  const sid = (s: State) => JSON.stringify(s.sentinels.map((x) => x.id));
  if (sid(a) !== sid(b)) diffs.push("sentinel customer IDs changed");
  const iid = (s: State) => JSON.stringify((s.interactions ?? []).map((x) => `${x.id}:${x.customer_id}`).sort());
  if (iid(a) !== iid(b)) diffs.push("sentinel interactions changed");
  for (const k of ["changed", "removed", "added"] as const) {
    const v = (s: State) => JSON.stringify((s.sample[k] ?? []).map(lineView).sort());
    if (v(a) !== v(b)) diffs.push(`${k}-line sample changed`);
  }
  return diffs;
}

const stateEvidence = (s: State): Evidence => ({
  customers: s.customers,
  lines: s.lines,
  active_lines: s.activeLines,
  sentinels_found: s.sentinels.filter((x) => x.id).length,
  sentinel_interactions: s.interactions?.length ?? null,
});

function planMatches(value: unknown, code: string): boolean {
  if (value === null || value === undefined) return false;
  const v = String(value).trim().toLowerCase();
  const plan = PRICE_PLANS.find((p) => p.code === code);
  return v === code.toLowerCase() || (!!plan && v === plan.name.toLowerCase()) || v.includes(code.toLowerCase());
}

const isInactive = (r: Row) =>
  r.active === false || (r.ported_out_at !== null && r.ported_out_at !== undefined) || /port|inactive|removed|churn|cancel|terminated/i.test(String(r.contract_status ?? r.status ?? ""));

// ───────────────────────── M5 helpers ─────────────────────────

/** Quarantine rows from the response JSON: any array of objects with a row number and a reason. */
export function quarantineFromResponse(json: unknown): { row: number; reason: string }[] {
  const out: { row: number; reason: string }[] = [];
  const visit = (v: unknown, depth: number) => {
    if (depth > 4 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 5000)) {
        if (x && typeof x === "object" && !Array.isArray(x)) {
          const o = x as Row;
          const row = o.row_number ?? o.rowNumber ?? o.row ?? o.line;
          const reason = o.reason ?? o.reasons ?? o.error ?? o.message;
          if (typeof row === "number" && reason) out.push({ row, reason: Array.isArray(reason) ? reason.join("; ") : String(reason) });
          else visit(x, depth + 1);
        }
      }
      return;
    }
    for (const x of Object.values(v as Row)) visit(x, depth + 1);
  };
  visit(json, 0);
  return out;
}

/** Recall of the expected quarantine rows, trying the usual row-number offsets (header row, 0-based). */
export function quarantineRecall(found: { row: number; reason: string }[], expected: { row: number; reason: string }[]): { recall: number; offset: number; matched: number; missing: number[]; withoutReason: number } {
  let best = { recall: 0, offset: 0, matched: 0, missing: expected.map((e) => e.row), withoutReason: 0 };
  for (const offset of [0, -1, -2, 1]) {
    const byRow = new Map(found.map((f) => [f.row - offset, f]));
    const hits = expected.filter((e) => byRow.has(e.row));
    const recall = expected.length ? hits.length / expected.length : 0;
    if (recall > best.recall) {
      best = {
        recall,
        offset,
        matched: hits.length,
        missing: expected.filter((e) => !byRow.has(e.row)).map((e) => e.row),
        withoutReason: hits.filter((e) => !String(byRow.get(e.row)?.reason ?? "").trim()).length,
      };
    }
  }
  return best;
}

// ───────────────────────── Orchestration ─────────────────────────

export interface ImportRun {
  results: CheckResult[];
  /** Checks deliberately not written (month 2 already imported): earlier rows stand. */
  skipped: CheckKey[];
  context: Evidence;
}

const ALL: CheckKey[] = ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "D-a", "D-b", "D-c"];

export async function runImportChecks(input: ImportCheckInput): Promise<ImportRun> {
  const http = input.http;
  const exp = input.expected;
  const allInconclusive = (reason: string, evidence: Evidence = {}): ImportRun => ({ results: ALL.map((k) => inconclusive(k, reason, evidence)), skipped: [], context: evidence });
  let base: URL;
  try {
    base = new URL(new URL(input.deployedUrl).origin + "/");
  } catch {
    return allInconclusive("the submitted deployed URL is not a valid URL");
  }
  if (!input.logins.manager) return allInconclusive("no manager login in the submitted test logins", { logins: describeLogins(input.logins) });

  const fe = newFrontEnd(base);
  try {
    await crawlPublic(http, fe);
  } catch (err) {
    if (err instanceof BudgetExceeded) return allInconclusive("ran out of time while reading the front end");
  }
  const found = await findSupabase(http, fe, input.overrides);
  if (!found.target) return allInconclusive(found.problem ?? "the Supabase project could not be identified", { candidates: found.candidates });
  const sb = found.target;
  const sessions = await signInAll(sb, { ...input.logins, agents: [] });
  const manager = sessions.manager;
  if (!manager) return allInconclusive(`the manager could not sign in (${sessions.errors.filter((e) => !/agent/.test(e)).join("; ")})`, { supabase_url: sb.url });
  const p = new Probe(sb, manager);
  const timeout = input.uploadTimeoutMs ?? 100_000;
  const results: CheckResult[] = [];
  const skipped: CheckKey[] = [];
  const context: Evidence = { supabase_url: sb.url, manager: manager.email };

  try {
    const before = await snapshot(p, exp);
    context.baseline = stateEvidence(before);
    if (before.customers === null || before.lines === null) {
      return allInconclusive("the manager cannot read customer/line counts via the REST API (renamed tables, or no read access): check by hand", { ...context, baseline: stateEvidence(before) });
    }
    const addedPresent = (before.sample.added ?? []).length;
    const alreadyImported = addedPresent > Math.min(3, exp.month2.new_msisdns.length / 2);
    context.already_imported = alreadyImported;

    let afterFirst: State = before;
    if (!alreadyImported) {
      // Give the sentinels history to follow (M2) if they have none.
      let probes = 0;
      if ((before.interactions ?? []).length === 0) {
        for (const sId of before.sentinels.map((s) => s.id).filter((x): x is string => !!x)) {
          const note = `${PROBE_NOTE} (M2): sentinel history before the month-2 import`;
          const ins = await sb.probe.insert("interactions", { customer_id: sId, agent_id: manager.userId, outcome: "no_answer", notes: note }, manager);
          let ok = is2xx(ins.status);
          if (!ok) {
            const r = await http
              .request(new URL("/api/outcomes", base), { method: "POST", body: JSON.stringify({ customerId: sId, outcome: "no_answer", notes: note }), headers: { "content-type": "application/json", ...appAuthHeaders(sb.url, manager) }, timeoutMs: 15_000 })
              .catch(() => null);
            ok = !!r && is2xx(r.status);
          }
          if (ok) probes++;
        }
        if (probes) before.interactions = await p.interactionsOf(before.sentinels.map((s) => s.id).filter((x): x is string => !!x));
      }
      context.sentinel_probe_interactions = probes;

      const up = await upload(http, base, sb, manager, input.files.month2Name ?? "base_month2.xlsx", input.files.month2, timeout);
      context.month2_upload = uploadEvidence(up);
      if (up.status === 401 || up.status === 403) {
        for (const k of ["M1", "M2", "M3", "M4", "M5"] as const) results.push(inconclusive(k, `POST /api/import refused the manager (HTTP ${up.status}): session not accepted or not a manager`, { upload: uploadEvidence(up) }));
      } else if (up.status === 404) {
        for (const k of ["M1", "M2", "M3", "M4", "M5"] as const) results.push(inconclusive(k, "POST /api/import is not found (route renamed?)", { upload: uploadEvidence(up) }));
      } else if (up.status === null) {
        // A time-out may leave the import still running on their side: counts now would mislead.
        for (const k of ["M1", "M2", "M3", "M4", "M5"] as const) results.push(inconclusive(k, `the month-2 upload did not complete (${up.error}): the import may still be running, so the result is unknown`, { upload: uploadEvidence(up) }));
        afterFirst = await snapshot(p, exp);
      } else {
        afterFirst = await snapshot(p, exp);
        results.push(...judgeImport(exp, before, afterFirst, up));
        results.push(await judgeQuarantine(p, exp, up));
      }
    } else {
      skipped.push("M1", "M2", "M3", "M4", "M5");
    }

    // M6: the same file again changes nothing.
    const before6 = afterFirst;
    const up6 = await upload(http, base, sb, manager, input.files.month2Name ?? "base_month2.xlsx", input.files.month2, timeout);
    const after6 = await snapshot(p, exp);
    {
      const diffs = stateDiff(before6, after6);
      const ev: Evidence = { upload: uploadEvidence(up6), before: stateEvidence(before6), after: stateEvidence(after6), differences: diffs };
      const said = /already|duplicate|no changes|unchanged|nothing to/i.test(up6.body);
      if (up6.status === 401 || up6.status === 403) results.push(inconclusive("M6", `POST /api/import refused the manager (HTTP ${up6.status})`, ev));
      else if (up6.status === 404) results.push(inconclusive("M6", "POST /api/import is not found (route renamed?)", ev));
      else if (diffs.length) results.push(fail("M6", `Re-uploading the same month-2 file changed data: ${diffs.join("; ")}`, ev));
      else if (up6.status === null) results.push(inconclusive("M6", `the re-upload did not complete (${up6.error})`, ev));
      else if (up6.status >= 500) results.push(fail("M6", `Re-uploading the same file crashed (HTTP ${up6.status}), even though nothing changed`, ev));
      else if (!is2xx(up6.status) && !said) results.push(fail("M6", `Re-uploading the same file was rejected with HTTP ${up6.status} without saying it was already imported`, ev));
      else results.push(pass("M6", `Re-uploading the same month-2 file changed nothing (HTTP ${up6.status}${said ? ", reported as already imported" : ""})`, ev));
    }

    // M7: the drift file fails loudly, names the column, writes nothing.
    const up7 = await upload(http, base, sb, manager, input.files.driftName ?? "base_month2_drift.xlsx", input.files.drift, timeout);
    const after7 = await snapshot(p, exp);
    {
      const diffs = stateDiff(after6, after7);
      const names = [exp.drift.renamed.from, exp.drift.renamed.to, ...exp.drift.added];
      const named = names.filter((n) => up7.body.toLowerCase().includes(n.toLowerCase()));
      const ev: Evidence = { upload: uploadEvidence(up7), columns_named: named, differences: diffs };
      if (up7.status === 401 || up7.status === 403) results.push(inconclusive("M7", `POST /api/import refused the manager (HTTP ${up7.status})`, ev));
      else if (up7.status === null) results.push(inconclusive("M7", `the drift upload did not complete (${up7.error})`, ev));
      else if (is2xx(up7.status)) results.push(fail("M7", `The drift file (renamed ${exp.drift.renamed.from} → ${exp.drift.renamed.to}) was accepted with HTTP ${up7.status}${diffs.length ? ` and changed data: ${diffs.join("; ")}` : ""}`, ev));
      else if (diffs.length) results.push(fail("M7", `The drift file was rejected (HTTP ${up7.status}) but data changed: ${diffs.join("; ")}`, ev));
      else if (up7.status >= 500) results.push(fail("M7", `The drift file crashed the import (HTTP ${up7.status}) instead of a clear 4xx error`, ev));
      else if (!named.length) results.push(fail("M7", `The drift file was rejected (HTTP ${up7.status}) but the error does not name the changed column`, ev));
      else results.push(pass("M7", `The drift file was rejected with HTTP ${up7.status} naming ${named.join(", ")}, and nothing changed`, ev));
    }

    results.push(...(await dataChecks(p, input.now ?? new Date())));
    context.final = stateEvidence(after7);
  } catch (err) {
    // Out of time (or an unexpected error) part-way: what ran stands, the rest is inconclusive.
    const reason = err instanceof BudgetExceeded ? "the run's time budget ran out before this check: run the import checks again" : `the run stopped unexpectedly: ${describeError(err)}`;
    for (const k of ALL) if (!results.some((r) => r.key === k) && !skipped.includes(k)) results.push(inconclusive(k, reason));
    context.stopped = reason;
  }
  return { results, skipped, context };
}

function judgeImport(exp: HarnessExpected, before: State, after: State, up: Upload): CheckResult[] {
  const out: CheckResult[] = [];
  const upEv = uploadEvidence(up);
  const crashed = !is2xx(up.status);

  // M1
  {
    const delta = after.customers !== null && before.customers !== null ? after.customers - before.customers : null;
    const ev: Evidence = { before: before.customers, after: after.customers, delta, expected_new: exp.month2.new_customers, month1_expected: exp.month1.customers, upload: upEv };
    if (delta === null) out.push(inconclusive("M1", "customer counts unavailable after the import", ev));
    else if (delta === exp.month2.new_customers) out.push(pass("M1", `Customer count rose by exactly ${delta}, the number of new customers`, ev));
    else out.push(fail("M1", `Customer count changed by ${delta}; the file has ${exp.month2.new_customers} new customers${crashed ? ` (the upload returned ${up.status ?? up.error})` : ""}`, ev));
  }

  // M2
  {
    const found = before.sentinels.filter((s) => s.id);
    const changedIds = before.sentinels.filter((s, i) => s.id && after.sentinels[i]?.id !== s.id).map((s) => s.key);
    const afterSet = new Set((after.interactions ?? []).map((x) => `${x.id}:${x.customer_id}`));
    const lost = (before.interactions ?? []).filter((x) => !afterSet.has(`${x.id}:${x.customer_id}`));
    const ev: Evidence = { sentinels: before.sentinels.map((s, i) => ({ key: s.key, before: s.id, after: after.sentinels[i]?.id ?? null })), interactions_before: before.interactions?.length ?? null, interactions_after: after.interactions?.length ?? null, lost: lost.slice(0, 10).map((x) => x.id) };
    if (!found.length) out.push(inconclusive("M2", "none of the sentinel customers was found before the import (by reg no or name)", ev));
    else if (changedIds.length) out.push(fail("M2", `Sentinel customers got new IDs (history orphaned): ${changedIds.join(", ")}`, ev));
    else if (lost.length) out.push(fail("M2", `${lost.length} of ${before.interactions?.length} sentinel interactions were lost or re-linked`, ev));
    else if (!(before.interactions ?? []).length) out.push(pass("M2", `The ${found.length} sentinel customers kept their IDs (they had no interactions to follow)`, ev, "no sentinel interactions existed or could be created: history survival is inferred from stable customer IDs"));
    else out.push(pass("M2", `The ${found.length} sentinel customers kept their IDs and all ${before.interactions!.length} interactions`, ev));
  }

  // M3
  {
    const rows = after.sample.changed;
    const expectedChanges = exp.month2.changed.slice(0, SAMPLE);
    const delta = after.lines !== null && before.lines !== null ? after.lines - before.lines : null;
    const allowed = [exp.month2.lines_new, exp.month2.lines_new - exp.month2.lines_removed];
    if (!rows) out.push(inconclusive("M3", "changed lines could not be read (no msisdn_e164 column?)", { delta, upload: upEv }));
    else {
      const dup: string[] = [];
      const stale: string[] = [];
      for (const c of expectedChanges) {
        const mine = rows.filter((r) => msisdnOf(r) === c.msisdn_e164);
        if (mine.length > 1) dup.push(c.msisdn_e164);
        const r = mine[0];
        if (!r) {
          stale.push(`${c.msisdn_e164} missing`);
          continue;
        }
        if (c.field === "Priceplan") {
          const k = pickKey(r, "priceplan", /plan/i);
          if (!k || !planMatches(r[k], c.to)) stale.push(`${c.msisdn_e164} plan ${k ? String(r[k]) : "?"} (expected ${c.to})`);
        } else {
          const k = pickKey(r, "contract_end_date", /end/i);
          if (!k || !String(r[k] ?? "").startsWith(c.to)) stale.push(`${c.msisdn_e164} end ${k ? String(r[k]) : "?"} (expected ${c.to})`);
        }
      }
      const ev: Evidence = { sampled: expectedChanges.length, duplicated: dup, not_updated: stale.slice(0, 15), lines_before: before.lines, lines_after: after.lines, line_delta: delta, allowed_delta: allowed };
      const deltaOk = delta !== null && allowed.includes(delta);
      if (dup.length) out.push(fail("M3", `${dup.length} changed lines are duplicated`, ev));
      else if (stale.length) out.push(fail("M3", `${stale.length} of ${expectedChanges.length} sampled changed lines were not updated`, ev));
      else if (!deltaOk) out.push(fail("M3", `Line count changed by ${delta}; expected ${exp.month2.lines_new} new lines (duplicates or reformatted numbers created extra lines?)`, ev));
      else out.push(pass("M3", `${expectedChanges.length} sampled changed line${expectedChanges.length === 1 ? "" : "s"} updated in place; line count rose by ${delta}`, ev));
    }
  }

  // M4
  {
    const rows = after.sample.removed;
    const removed = exp.month2.removed_msisdns.slice(0, SAMPLE);
    if (!rows) out.push(inconclusive("M4", "removed lines could not be read"));
    else {
      const gone = removed.filter((m) => !rows.some((r) => msisdnOf(r) === m));
      const stillActive = removed.filter((m) => rows.some((r) => msisdnOf(r) === m && !isInactive(r)));
      const ev: Evidence = { sampled: removed.length, deleted: gone.length, still_active: stillActive.slice(0, 10), active_before: before.activeLines, active_after: after.activeLines };
      if (gone.length === removed.length && removed.length)
        out.push(fail("M4", `Removed (ported) lines were hard-deleted (${gone.length} of ${removed.length} sampled)`, ev, "hard delete earns partial credit if the README documents why"));
      else if (gone.length) out.push(fail("M4", `${gone.length} of ${removed.length} sampled removed lines were deleted`, ev));
      else if (stillActive.length) out.push(fail("M4", `${stillActive.length} of ${removed.length} removed lines are still active`, ev));
      else out.push(pass("M4", `${removed.length === 1 ? "The sampled removed line was" : `All ${removed.length} sampled removed lines were`} kept and marked inactive/ported`, ev));
    }
  }
  return out;
}

async function judgeQuarantine(p: Probe, exp: HarnessExpected, up: Upload): Promise<CheckResult> {
  const expected = exp.month2.quarantine_expected;
  if (!expected.length) return inconclusive("M5", "the bundle lists no expected quarantine rows");
  let found: { row: number; reason: string }[] = [];
  let source = "none";
  const runs = await p.sb.probe.select("import_runs", { select: "id,file_name,status,created_at", order: "created_at.desc", limit: "5" }, p.s);
  // The run this upload created (allowing for clock skew); an older run would be the wrong report.
  const run = (runs.rows ?? []).find((r) => new Date(String(r.created_at)).getTime() >= up.startedAt - 120_000);
  if (run) {
    const q = await p.sb.probe.select("quarantine_rows", { select: "row_number,reason", import_run_id: `eq.${String(run.id)}`, limit: "2000" }, p.s);
    if (q.rows?.length) {
      found = q.rows.map((r) => ({ row: Number(r.row_number), reason: String(r.reason ?? "") }));
      source = `quarantine_rows of import run ${String(run.id).slice(0, 8)}`;
    }
  }
  if (!found.length) {
    found = quarantineFromResponse(up.json);
    if (found.length) source = "the import response";
  }
  const rec = quarantineRecall(found, expected);
  const ambiguous = expected.filter((e) => e.reason === "ambiguous_date").map((e) => e.row);
  const ev: Evidence = { source, expected: expected.length, quarantined: found.length, matched: rec.matched, recall: Math.round(rec.recall * 100) / 100, row_offset: rec.offset, missing_rows: rec.missing.slice(0, 20), without_reason: rec.withoutReason, ambiguous_expected: ambiguous.length };
  if (!found.length) return fail("M5", "No quarantine report found (no quarantine_rows for the run and none in the import response)", ev);
  if (rec.recall >= 0.9 && rec.withoutReason === 0) return pass("M5", `Quarantine lists ${rec.matched} of ${expected.length} ambiguous/invalid rows, with reasons`, ev);
  if (rec.withoutReason) return fail("M5", `${rec.withoutReason} quarantined rows have no reason`, ev);
  return fail("M5", `Quarantine lists only ${rec.matched} of ${expected.length} expected ambiguous/invalid rows`, ev);
}

// ───────────────────────── D-a … D-c ─────────────────────────

const E164_ZA = /^\+27\d{9}$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const LANDLINE = /^\+27[1-5]\d{8}$/;

function landlineMarked(r: Row, key: string): boolean | null {
  const v = r[key];
  if (/^is_?landline$/i.test(key)) return v === true;
  if (/^is_?mobile$/i.test(key)) return v === false;
  if (typeof v === "string") return /land|fixed|fixed_?line|geographic/i.test(v) ? true : /mobile|cell|gsm/i.test(v) ? false : null;
  return null;
}

async function dataChecks(p: Probe, now: Date): Promise<CheckResult[]> {
  const all = await p.sb.probe.selectAll<Row>("lines", { select: "*" }, p.s, 5000);
  const rows = all.rows;
  if (!rows) {
    const why = `the manager cannot read lines via REST (HTTP ${all.status}${all.code ? ` ${all.code}` : ""})`;
    return [inconclusive("D-a", why), inconclusive("D-b", why), inconclusive("D-c", why)];
  }
  const out: CheckResult[] = [];
  const capped = rows.length >= 5000 ? "first 5,000 lines checked" : undefined;
  const sample = rows[0];

  // D-a
  {
    const key = pickKey(sample, "msisdn_e164", /msisdn|phone|number/i);
    const values = key ? rows.map((r) => r[key]) : [];
    const numeric = values.filter((v) => typeof v === "number");
    const bad = values.filter((v) => v !== null && v !== undefined && (typeof v !== "string" || !E164.test(v)));
    const notZa = values.filter((v) => typeof v === "string" && E164.test(v) && !E164_ZA.test(v));
    const typeKey = sample ? Object.keys(sample).find((k) => /^(line_?type|number_?type|phone_?type|kind|type|is_?landline|is_?mobile|device_?class)$/i.test(k)) : undefined;
    const landlines = key ? rows.filter((r) => typeof r[key] === "string" && LANDLINE.test(String(r[key]))) : [];
    const ev: Evidence = { column: key, checked: values.length, numeric: numeric.length, not_e164: bad.slice(0, 10).map(String), non_za: notZa.length, landlines: landlines.length, type_column: typeKey ?? null };
    let landlineVerdict: "ok" | "wrong" | "unknown" = "unknown";
    if (typeKey && landlines.length) {
      const wrong = landlines.filter((r) => landlineMarked(r, typeKey) !== true);
      const mobilesAsLand = rows.filter((r) => key && typeof r[key] === "string" && /^\+27[6-8]/.test(String(r[key])) && landlineMarked(r, typeKey) === true);
      ev.landlines_unmarked = wrong.length;
      ev.mobiles_marked_landline = mobilesAsLand.length;
      landlineVerdict = wrong.length || mobilesAsLand.length ? "wrong" : "ok";
    } else if (landlines.length) {
      const cp = await p.sb.probe.select("contact_points", { select: "type,value", limit: "1000" }, p.s);
      const cpLand = (cp.rows ?? []).filter((r) => typeof r.value === "string" && LANDLINE.test(String(r.value).replace(/\s+/g, "")));
      if (cpLand.length) {
        const wrong = cpLand.filter((r) => !/land|fixed/i.test(String(r.type ?? "")));
        ev.contact_point_landlines = cpLand.length;
        ev.contact_point_landlines_mistyped = wrong.length;
        landlineVerdict = wrong.length ? "wrong" : "ok";
      }
    }
    if (!key) out.push(inconclusive("D-a", "no phone-number column found on lines", ev));
    else if (numeric.length) out.push(fail("D-a", `${numeric.length} phone numbers are stored as numbers (leading zero lost)`, ev));
    else if (bad.length) out.push(fail("D-a", `${bad.length} of ${values.length} phone numbers are not E.164 text`, ev));
    else if (landlineVerdict === "wrong") out.push(fail("D-a", "Phones are E.164, but landlines are not distinguished from mobiles", ev));
    else if (landlineVerdict === "ok") out.push(pass("D-a", `All ${values.length} phone numbers are E.164 text and landlines are marked as such`, ev, capped));
    else
      out.push(
        pass(
          "D-a",
          `All ${values.length} phone numbers are E.164 text`,
          ev,
          landlines.length ? "landline marking not determined (no type column on lines, no typed contact points): confirm by hand" : "no landline numbers found to check the landline marking",
        ),
      );
  }

  // D-b
  {
    const endKey = pickKey(sample, "contract_end_date", /end_?date|contract_?end/i);
    const statusKey = pickKey(sample, "contract_status", /status/i);
    const today = now.toISOString().slice(0, 10);
    if (!endKey || !statusKey) out.push(inconclusive("D-b", "no contract end date / status columns found on lines", { columns: sample ? Object.keys(sample).slice(0, 30) : [] }));
    else {
      const stale = rows.filter((r) => typeof r[endKey] === "string" && String(r[endKey]).slice(0, 10) < today && /^\s*in[\s_-]?contract\s*$/i.test(String(r[statusKey] ?? "")));
      const ev: Evidence = { checked: rows.length, today, expired_in_contract: stale.length, examples: stale.slice(0, 5).map((r) => `${msisdnOf(r)} ends ${String(r[endKey]).slice(0, 10)} status ${String(r[statusKey])}`) };
      if (stale.length) out.push(fail("D-b", `${stale.length} line${stale.length === 1 ? "" : "s"} whose contract ended before ${today} still say${stale.length === 1 ? "s" : ""} InContract (status not derived from the end date)`, ev));
      else out.push(pass("D-b", `No expired line is marked InContract (${rows.length} lines checked)`, ev, capped));
    }
  }

  // D-c
  {
    const dateKeys = sample ? Object.keys(sample).filter((k) => /date|_at$|end|start/i.test(k)) : [];
    const epoch = rows.filter((r) => dateKeys.some((k) => typeof r[k] === "string" && /^19(69|70)-/.test(String(r[k]))));
    const ev: Evidence = { checked: rows.length, date_columns: dateKeys, epoch_rows: epoch.length, examples: epoch.slice(0, 5).map((r) => String(msisdnOf(r))) };
    if (!dateKeys.length) out.push(inconclusive("D-c", "no date columns found on lines", ev));
    else if (epoch.length) out.push(fail("D-c", `${epoch.length} line${epoch.length === 1 ? "" : "s"} carr${epoch.length === 1 ? "ies" : "y"} a 1970 (epoch) date instead of null/quarantine`, ev));
    else out.push(pass("D-c", `No epoch (1970) dates in ${rows.length} lines`, ev, capped));
  }
  return out;
}
