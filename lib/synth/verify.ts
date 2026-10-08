import { normaliseCompanyName } from "./names";
import { col, readWorkbook, type CellOut, type ReadSheet } from "./xlsx";

/**
 * Re-derives the planted-defect counts of a generated bundle from the cells alone (no generator
 * internals), so tests can check the answer key against what a candidate actually downloads.
 */

const isDate = (v: CellOut): v is Date => v instanceof Date;
const str = (v: CellOut) => (typeof v === "string" ? v : null);
const day = 86_400_000;

function sheet(m: Map<string, ReadSheet>, name: string): ReadSheet {
  const s = m.get(name);
  if (!s) throw new Error(`sheet "${name}" missing`);
  return s;
}

export interface ADerived {
  counts: Record<string, number | null>;
  details: Record<string, Record<string, unknown>>;
  figures: Record<string, number>;
  shares: Record<string, number>;
}

export async function deriveBundleA(xlsx: Buffer | string, exportIso = "2026-10-07"): Promise<ADerived> {
  const wb = await readWorkbook(xlsx);
  const base = sheet(wb, "vsam base raw");
  const ws = sheet(wb, "worksheet");
  const dl = sheet(wb, "dialler September stats");
  const il = sheet(wb, "interval log");
  const exportDate = new Date(`${exportIso}T00:00:00Z`);

  const B = (h: string) => col(base, h);
  const lines = base.rows.map((r) => r.cells);
  const acctOf = (c: CellOut[]) => Number(c[B("Account No")]);
  const accounts = new Set(lines.map(acctOf));

  // D03: same company under several accounts.
  const namesByAccount = new Map<number, string>();
  for (const c of lines) namesByAccount.set(acctOf(c), String(c[B("Customer Name")]));
  const groups = (key: (n: string) => string) => {
    const g = new Map<string, Set<number>>();
    for (const [a, n] of namesByAccount) g.set(key(n), (g.get(key(n)) ?? new Set()).add(a));
    return [...g.values()].filter((s) => s.size > 1).reduce((s, x) => s + (x.size - 1), 0);
  };
  const exactPairs = groups((n) => n);
  const normPairs = groups(normaliseCompanyName);

  const W = (h: string | null) => col(ws, h);
  const wrows = ws.rows.map((r) => r.cells);
  const N = wrows.length;

  // D05 / D07 contact column.
  const contact = wrows.map((c) => c[W("Contact")]);
  const landlinePrefix = /^0[1-5]/;
  let bracket = 0, stripped = 0, zero = 0, other = 0, landline = 0, numberCells = 0;
  for (const v of contact) {
    if (typeof v === "number") {
      numberCells++;
      if (v === 0) zero++;
      else {
        stripped++;
        if (landlinePrefix.test(`0${v}`)) landline++;
      }
    } else if (typeof v === "string" && /^\(\d{3}\) \d{7}$/.test(v)) {
      bracket++;
      if (landlinePrefix.test(v.slice(1, 4))) landline++;
    } else other++;
  }

  // D08 date contacted.
  let us = 0, padded = 0, ydm = 0, impossible = 0, excel = 0, blank = 0;
  for (const c of wrows) {
    const v = c[W("date contacted")];
    if (v === null) blank++;
    else if (isDate(v)) excel++;
    else {
      const s = String(v);
      const y = s.match(/^\d{4}\/(\d{2})\/(\d{2})$/);
      const p = s.match(/^(\d{2})\/(\d{2})\/\d{4}$/);
      if (y) {
        if (Number(y[1]) > 12) impossible++;
        else ydm++;
      }
      else if (p && Number(p[1]) <= 12 && Number(p[2]) <= 12) padded++;
      else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) us++;
    }
  }

  const blocks = wrows.map((c) => c[W("Completed Allocated Blocks? (4/4)")]);
  const statuses = wrows.map((c) => str(c[W("Call Status")]) ?? "");
  const ooc = new Map<number, number>();
  for (const c of lines) if (c[B("Contract Status")] === "Out Of Contract") ooc.set(acctOf(c), (ooc.get(acctOf(c)) ?? 0) + 1);
  const matched = wrows.filter((c) => accounts.has(Number(c[W("Account No")])));
  const drift = matched.filter((c) => Number(c[W("Out Of Contract")]) !== (ooc.get(Number(c[W("Account No")])) ?? 0));
  const dead = (s: string) => !s.trim() || /^(no answer|not interested|wrong number|number not in service)/i.test(s.trim());

  // Base dates.
  const end = (c: CellOut[]) => c[B("Contract End Date")];
  const epoch = lines.filter((c) => isDate(end(c)) && (end(c) as Date).getUTCFullYear() === 1970 && c[B("Contract Term")] === 0);
  const stale = lines.filter((c) => c[B("Contract Status")] === "InContract" && isDate(end(c)) && (end(c) as Date) < exportDate);
  const windowLines = lines.filter((c) => isDate(end(c)) && (end(c) as Date) >= exportDate && (end(c) as Date).getTime() <= exportDate.getTime() + 90 * day);
  const windowAccounts = new Set(windowLines.map(acctOf));
  const charge = lines.map((c) => c[B("chg_subs")]);

  // Constant columns, AM spelling.
  const distinct = (h: string) => new Set(lines.map((c) => String(c[B(h)])));
  const constants = ["Telemetry", "Region", "Channel", "RSM", "AM"].filter((h) => distinct(h).size === 1);
  const amBase = String(lines[0][B("AM")]);
  const diallerNames = dl.rows.map((r) => String(r.cells[col(dl, "Agent")]));
  const sameLetters = (a: string, b: string) => a !== b && [...a].sort().join("") === [...b].sort().join("");
  const amDialler = diallerNames.find((n) => sameLetters(n, amBase)) ?? null;

  // Interval log.
  const I = (h: string) => col(il, h);
  const irows = il.rows.map((r) => r.cells);
  const sum = (h: string) => irows.reduce((s, c) => s + Number(c[I(h)] ?? 0), 0);
  const allHeaders = [...base.headers, ...ws.headers, ...dl.headers, ...il.headers].filter((h): h is string => h !== null);

  const counts: Record<string, number | null> = {
    D01: null,
    D02: new Set(wrows.map((c) => Number(c[W("Account No")]))).size,
    D03: normPairs,
    D04: wrows.filter((c) => !accounts.has(Number(c[W("Account No")]))).length,
    D05: N - (bracket - contact.filter((v) => typeof v === "string" && /^\(0[1-5]/.test(v)).length),
    D06: wrows.filter((c) => c[W("Account Holder Name")] === 0).length,
    D07: numberCells,
    D08: us + padded + ydm + impossible,
    D09: blocks.filter(isDate).length,
    D10: epoch.length,
    D11: stale.length,
    D12: lines.filter((c) => c[B("Month Remaining In Contract")] === "Unknown").length,
    D13: new Set(statuses.filter(Boolean)).size,
    D14: statuses.filter((s) => s === "Call back / Follow up").length,
    D15: statuses.filter((s) => s === "Engaged Requested quote").length,
    D16: wrows.filter((c) => c[W("Comment Status")] === "DONE").length,
    D17: drift.length,
    D18: null,
    D19: dl.rows.length,
    D20: dl.rows.length,
    D21: irows.filter((c) => Number(c[I("Calls ")]) === 0).length,
    D22: sum("Sales"),
    D23: null,
  };

  const details: ADerived["details"] = {
    D01: { lines: lines.length, accounts: accounts.size, has_reg_or_customer_id: base.headers.some((h) => /\breg(\.|istration)?\s*(no|number)\b|\bregistration\b|\bcustomer\s*id\b/i.test(h ?? "")) },
    D02: { base_has_contact_columns: base.headers.some((h) => /phone|e-?mail|whatsapp|contact|cell|mobile/i.test(h ?? "")) },
    D03: { exact_pairs: exactPairs, normalised_pairs: normPairs },
    D05: { bracket_style: bracket, stripped_integer: stripped, zero_placeholder: zero, landline, other_format: other },
    D06: { holder_zero: counts.D06, email_blank: wrows.filter((c) => c[W("Email")] === null).length },
    D07: { number_cells: numberCells, string_cells: N - numberCells },
    D08: { us_style: us, padded_ambiguous: padded, yyyy_dd_mm: ydm, impossible, excel_dates: excel, blanks: blank },
    D09: { date_cells: blocks.filter(isDate).length, text_zero: blocks.filter((b) => b === "0/4").length },
    D13: { trailing_space_rows: statuses.filter((s) => s !== s.trimEnd()).length, column_f_header: ws.headers[5] },
    D14: { next_action_empty: wrows.filter((c) => c[W("Next Action")] === null).length, action_required_empty: wrows.filter((c) => c[W("Action Required")] === null).length },
    D15: {
      processing: wrows.filter((c) => c[W("Application Status")] === "Processing").length,
      approved: wrows.filter((c) => c[W("Application Status")] === "Approved").length,
      application_status_blank: wrows.filter((c) => c[W("Application Status")] === null).length,
    },
    D16: { done_on_dead_calls: wrows.filter((c, i) => c[W("Comment Status")] === "DONE" && dead(statuses[i])).length },
    D17: { matched_accounts: matched.length },
    D18: { constant_base_columns: constants, am_base: amBase, am_dialler: amDialler },
    D19: { has_msisdn_or_timestamp: dl.headers.some((h) => /msisdn|time ?stamp|date|number/i.test(h ?? "")) },
    D20: { test_or_system_users: diallerNames.filter((n) => /^test\b|support/i.test(n)), interval_agents: new Set(irows.map((c) => c[I("Agent ")])).size },
    D21: {
      trailing_space_headers: il.headers.filter((h) => h !== null && h !== h.trimEnd()),
      target_string: [...new Set(irows.map((c) => c[I("Target ")]))],
      day_status_filled: irows.filter((c) => c[I("Day Status ")] !== null).length,
    },
    D22: { calls: sum("Calls "), connected: sum("Connected"), opportunities: sum("Opportunities "), sales: sum("Sales") },
    D23: { consent_columns: allHeaders.filter((h) => /consent|opt.?out|do.?not.?contact|dnc/i.test(h)) },
  };

  const numericCharges = charge.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  const q = (p: number) => numericCharges[Math.floor(p * (numericCharges.length - 1))];
  const lpa = new Map<number, number>();
  for (const c of lines) lpa.set(acctOf(c), (lpa.get(acctOf(c)) ?? 0) + 1);
  const lpaSorted = [...lpa.values()].sort((a, b) => a - b);
  const segByAccount = new Map<number, string>();
  for (const c of lines) segByAccount.set(acctOf(c), String(c[B("Segment")]));
  const segShare = (s: string) => [...segByAccount.values()].filter((x) => x === s).length / segByAccount.size;
  const termShare = (t: number) => lines.filter((c) => c[B("Contract Term")] === t).length / lines.length;

  return {
    counts,
    details,
    figures: {
      base_lines: lines.length,
      base_accounts: accounts.size,
      worksheet_accounts: N,
      window_lines: windowLines.length,
      window_accounts: windowAccounts.size,
      window_charges_zar: Math.round(windowLines.reduce((s, c) => s + (typeof c[B("chg_subs")] === "number" ? (c[B("chg_subs")] as number) : 0), 0) * 100) / 100,
      incontract_expired: stale.length,
      lines_per_account_median: lpaSorted[Math.floor((lpaSorted.length - 1) / 2)],
      lines_per_account_max: lpaSorted[lpaSorted.length - 1],
      chg_median: q(0.5),
      chg_q1: q(0.25),
      chg_q3: q(0.75),
      chg_max: numericCharges[numericCharges.length - 1],
      interval_rows: irows.length,
      dialler_rows: dl.rows.length,
    },
    shares: {
      sme: segShare("SME"),
      le: segShare("LE"),
      pe: segShare("PE"),
      term_24: termShare(24),
      term_36: termShare(36),
      term_short: [1, 3, 6, 12, 18].map(termShare).reduce((s, x) => s + x, 0),
      out_of_contract: lines.filter((c) => c[B("Contract Status")] === "Out Of Contract").length / lines.length,
      window: windowLines.length / lines.length,
      chg_zero: charge.filter((v) => v === 0).length / lines.length,
      chg_blank: charge.filter((v) => v === null).length / lines.length,
      no_device: lines.filter((c) => c[B("Device Type")] === null).length / lines.length,
      worksheet_of_accounts: N / accounts.size,
      contact_bracket: bracket / N,
      contact_stripped: stripped / N,
      contact_zero: zero / N,
      holder_zero: (counts.D06 ?? 0) / N,
      email_blank: (details.D06.email_blank as number) / N,
      done: (counts.D16 ?? 0) / N,
      ooc_drift: drift.length / matched.length,
    },
  };
}

// ───────────────────────── Bundle C month-2 deltas ─────────────────────────

/** Normalises any Msisdn cell spelling to E.164, or null when it is not a usable number. */
export function msisdnToE164(v: CellOut): string | null {
  if (v === null || v === 0) return null;
  let d = String(v).trim().replace(/[\s().-]/g, "");
  if (d.startsWith("+27")) d = `0${d.slice(3)}`;
  else if (/^27\d{9}$/.test(d)) d = `0${d.slice(2)}`;
  else if (/^\d{9}$/.test(d)) d = `0${d}`;
  return /^0\d{9}$/.test(d) ? `+27${d.slice(1)}` : null;
}

export interface MonthDiff {
  month1Lines: number;
  month2FileRows: number;
  month2Active: number;
  newLines: string[];
  removedLines: string[];
  changedLines: string[];
  duplicateRows: number;
  ambiguousDateRows: number;
}

export async function diffMonths(month1: Buffer | string, month2: Buffer | string): Promise<MonthDiff> {
  const [a, b] = [await readWorkbook(month1), await readWorkbook(month2)];
  const s1 = sheet(a, "vsam base raw");
  const s2 = sheet(b, "vsam base raw");
  const key = (s: ReadSheet, c: CellOut[]) => msisdnToE164(c[col(s, "Msisdn")]);
  const fp = (s: ReadSheet, c: CellOut[]) => {
    const e = c[col(s, "Contract End Date")];
    return `${c[col(s, "Priceplan")]}|${isDate(e) ? e.toISOString().slice(0, 10) : String(e)}`;
  };
  const m1 = new Map<string, string>();
  for (const r of s1.rows) {
    const k = key(s1, r.cells);
    if (k) m1.set(k, fp(s1, r.cells));
  }
  const seen = new Set<string>();
  const exact = new Set<string>();
  let dups = 0;
  let ambiguous = 0;
  const m2 = new Map<string, string>();
  for (const r of s2.rows) {
    const raw = JSON.stringify(r.cells);
    if (exact.has(raw)) dups++;
    exact.add(raw);
    const e = r.cells[col(s2, "Contract End Date")];
    const pm = typeof e === "string" ? e.match(/^(\d{2})\/(\d{2})\/\d{4}$/) : null;
    const isAmbiguous = !!pm && Number(pm[1]) <= 12 && Number(pm[2]) <= 12;
    if (isAmbiguous) ambiguous++;
    const k = key(s2, r.cells);
    if (!k) continue;
    seen.add(k);
    if (isAmbiguous) continue; // the date cannot be known: not counted as a change
    m2.set(k, fp(s2, r.cells));
  }
  return {
    month1Lines: m1.size,
    month2FileRows: s2.rows.length,
    month2Active: seen.size,
    newLines: [...seen].filter((k) => !m1.has(k)),
    removedLines: [...m1.keys()].filter((k) => !seen.has(k)),
    changedLines: [...m2.entries()].filter(([k, v]) => m1.has(k) && m1.get(k) !== v).map(([k]) => k),
    duplicateRows: dups,
    ambiguousDateRows: ambiguous,
  };
}
