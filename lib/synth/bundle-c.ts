import fs from "node:fs";
import path from "node:path";
import type { Workbook } from "exceljs";
import type { ExpectedMonth2 } from "./answer-key";
import { generateBase, monthsBucket, PRICE_PLANS, makeRegNo, type Base, type Line } from "./base";
import { addDays, addMonths, iso, parseIso } from "./dates";
import { bracketStyle, makeCompanies, makeLandline, makeMobile, makePerson, normaliseCompanyName, personEmail, toE164, type Person } from "./names";
import { createSynthRng, type SynthRng } from "./rng";
import { addSheet, newWorkbook, type CellIn } from "./xlsx";

/**
 * Bundle C (SWE Test 1, docs/07 + docs/11): the messy month-1 base, the agents' contact sheets,
 * the legal opt-out list (company names only), the BA's handoff pack (assessment-kits/HANDOFF.md),
 * and the held-back month-2 files with known deltas plus expected_month2.json for the import
 * harness (M1–M7).
 */

export const C_FILES = {
  month1: "base_month1.xlsx",
  contacts: "contacts_agent_sheets.xlsx",
  optouts: "optouts_legal.xlsx",
  month2: "base_month2.xlsx",
  drift: "base_month2_drift.xlsx",
  expected: "expected_month2.json",
  handoff: "HANDOFF.md",
} as const;

/** Where the candidate-facing handoff pack lives, relative to the repository root. */
export const C_HANDOFF_SOURCE = path.join("assessment-kits", "HANDOFF.md");

/**
 * The handoff pack (stories RD-01..RD-12, business rules, access matrix), read from
 * assessment-kits/HANDOFF.md by walking up from `from` (the generator and the tests run inside
 * the repository). One source of truth: edit assessment-kits/HANDOFF.md, then regenerate.
 */
export function readHandoffPack(from: string = process.cwd()): string {
  let dir = path.resolve(from);
  for (;;) {
    const candidate = path.join(dir, C_HANDOFF_SOURCE);
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8");
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`${C_HANDOFF_SOURCE} not found above ${from}: run the generator from inside the repository`);
    dir = up;
  }
}

export const C_COLUMNS = [
  "Account No", "Reg No", "Customer Name", "Msisdn", "dealer_code", "Segment", "Contract Term", "Contract End Date", "Contract Status",
  "Month Remaining In Contract", "Priceplan", "Priceplan Name", "Device Type", "Device Model", "chg_subs",
] as const;

const MONTH1 = "2026-10-07";
const MONTH2 = "2026-11-07";

type PhoneFormat = "stripped" | "msisdn" | "bracket" | "landline" | "zero" | "spaced";

/** One month-1 line plus how its cells are written. */
interface CLine {
  line: Line;
  customerId: number;
  regNo: string | null;
  name: string;
  dealer: string;
  segment: string;
  phoneFormat: PhoneFormat;
  /** National number for landlines (lines keep their mobile otherwise). */
  national: string;
  endFormat: "date" | "us_string" | "epoch";
}

function phoneCell(format: PhoneFormat, national: string): CellIn {
  switch (format) {
    case "stripped":
    case "landline":
      return Number(national); // leading zero lost
    case "msisdn":
      return Number(`27${national.slice(1)}`);
    case "bracket":
      return bracketStyle(national);
    case "zero":
      return 0;
    case "spaced":
      return `${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
  }
}

/** Month-2 format drift: new spellings of the SAME number (they must not create new lines). */
function driftPhone(rng: SynthRng, national: string): string {
  const n = national;
  return rng.pick([
    `+27 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`,
    `27 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`,
    `${n.slice(0, 3)}.${n.slice(3, 6)}.${n.slice(6)}`,
    `${n} `,
    `(${n.slice(0, 3)})${n.slice(3, 6)}-${n.slice(6)}`,
    `+27${n.slice(1)}`,
  ]);
}

function endCell(c: CLine): CellIn {
  const d = c.line.endDate;
  if (c.endFormat === "us_string") return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
  return d;
}

function rowFor(c: CLine, overrides: Partial<Record<(typeof C_COLUMNS)[number], CellIn>> = {}): CellIn[] {
  const l = c.line;
  const base: Record<(typeof C_COLUMNS)[number], CellIn> = {
    "Account No": l.accountNo,
    "Reg No": c.regNo,
    "Customer Name": c.name,
    Msisdn: phoneCell(c.phoneFormat, c.national),
    dealer_code: c.dealer,
    Segment: c.segment,
    "Contract Term": l.term,
    "Contract End Date": endCell(c),
    "Contract Status": l.status,
    "Month Remaining In Contract": l.monthsBucket,
    Priceplan: l.plan.code,
    "Priceplan Name": l.plan.name,
    "Device Type": l.device?.type ?? null,
    "Device Model": l.device?.model ?? null,
    chg_subs: l.chg,
  };
  return C_COLUMNS.map((k) => (k in overrides ? overrides[k]! : base[k]));
}

const validKey = (c: CLine) => (c.phoneFormat === "zero" ? null : toE164(c.national));

export interface BundleC {
  month1: Workbook;
  contacts: Workbook;
  optouts: Workbook;
  month2: Workbook;
  drift: Workbook;
  expected: ExpectedMonth2;
  readme: string;
  /** HANDOFF.md for candidate/ (the BA's handoff pack). */
  handoff: string;
}

export const C_README = `# Kopano Renewal Desk: SWE Test 1 data pack

Everything in this pack is synthetic. Every name, number and email address is fictional.

| File | What it is |
|---|---|
| \`HANDOFF.md\` | The BA's handoff pack: the problem, user stories RD-01 to RD-12 with acceptance criteria, business rules, the access matrix, edge cases and what is out of scope. |
| \`base_month1.xlsx\` | The client's monthly base export (one row per phone line). This is the file their manager will upload every month. |
| \`contacts_agent_sheets.xlsx\` | Three agents' personal contact sheets, one tab per agent. They overlap and they disagree. |
| \`optouts_legal.xlsx\` | Legal's opt-out and "under legal review" list. It is keyed by company name only. |

## The starter repo

The BA's MVP is here: STARTER_REPO_URL

It is a public repository: all you need is a GitHub account, and there is no access to request.

1. Clone it, then push it **as it is, with its whole history**, to a new repository on your own
   GitHub account. Do not use GitHub's "Use this template" button (it drops the history) and do
   not fork it (forks are listed on the original, where everyone can see them).
2. Make your repository **public**. We read it, its history and its CI results without signing in
   to GitHub, so a private repository cannot be graded.
3. Do your work there and submit that repository's URL. We grade the commit that is the latest
   when you submit, so do not rewrite or force-push over it after submitting.

Read the brief in the platform for what to build. A later month's export will be used when we grade your import.
`;

export function buildBundleC(seed: number, version: string, opts: { handoffMd?: string } = {}): BundleC {
  const handoff = opts.handoffMd ?? readHandoffPack();
  const root = createSynthRng(seed).fork("bundle_c");
  const br = root.fork("base");
  const base: Base = generateBase(br, {
    accounts: br.int(600, 640),
    lineRange: [2150, 2300],
    maxLinesPerAccount: 34,
    exactDuplicatePairs: 6,
    variantDuplicatePairs: 6,
    staleInContract: br.int(40, 50),
    epochLines: 4,
    windowShare: 0.09,
    oocShare: 0.33,
    exportDate: MONTH1,
    regNoShare: 0.92,
  });
  const acct = new Map(base.accounts.map((a) => [a.accountNo, a]));
  const cust = new Map(base.customers.map((c) => [c.id, c]));

  // ── Month 1 cell formats ──
  const fr = root.fork("formats");
  const phones = new Set(base.lines.map((l) => l.mobile));
  const clines: CLine[] = base.lines.map((l) => {
    const a = acct.get(l.accountNo)!;
    const c = cust.get(a.customerId)!;
    const phoneFormat = fr.weighted([
      ["stripped", 820],
      ["msisdn", 60],
      ["bracket", 70],
      ["landline", 25],
      ["zero", 5],
      ["spaced", 20],
    ] as const);
    return {
      line: l,
      customerId: c.id,
      regNo: a.regNoShown,
      name: a.displayName,
      dealer: a.dealerCode,
      segment: c.segment,
      phoneFormat,
      national: phoneFormat === "landline" ? makeLandline(fr, phones) : l.mobile,
      endFormat: l.kind === "epoch" ? "epoch" : l.endDate.getUTCDate() > 12 && fr.chance(0.025) ? "us_string" : "date",
    };
  });
  const month1Rows = clines.map((c) => rowFor(c));

  const month1 = newWorkbook("Kopano Connect BI export");
  addSheet(month1, { name: "vsam base raw", headers: [...C_COLUMNS], rows: month1Rows, dateFormats: { 7: "yyyy-mm-dd" } });

  // ── Month 2 deltas ──
  const mr = root.fork("month2");
  const m2Date = parseIso(MONTH2);
  const eligible = clines.filter((c) => c.phoneFormat !== "zero" && c.endFormat !== "epoch");
  const nLines = clines.length;
  const nRemoved = Math.round(nLines * 0.015);
  const nChanged = Math.round(nLines * 0.04);
  const nNew = Math.round(nLines * 0.02);
  const nNewExisting = 15;

  // Sentinels first: five customers whose lines all stay unchanged.
  const customersWithReg = base.customers.filter((c) => clines.filter((x) => x.customerId === c.id).every((x) => x.regNo !== null && x.phoneFormat !== "zero" && x.endFormat === "date"));
  const sentinelCustomers = mr.sample(customersWithReg.filter((c) => clines.some((x) => x.customerId === c.id)), 5);
  const sentinelIds = new Set(sentinelCustomers.map((c) => c.id));
  const pool = mr.shuffle(eligible.filter((c) => !sentinelIds.has(c.customerId)));
  const removed = pool.slice(0, nRemoved);
  const changed = pool.slice(nRemoved, nRemoved + nChanged);
  const stable = pool.slice(nRemoved + nChanged);
  const phoneDefects = stable.slice(0, 20);
  const ambiguous = stable.slice(20, 30);
  const removedSet = new Set(removed);

  const changes: { msisdn_e164: string; field: "Priceplan" | "Contract End Date"; from: string; to: string }[] = [];
  const changedLines = new Map<CLine, CLine>();
  for (const c of changed) {
    const l = { ...c.line };
    if (mr.chance(0.5)) {
      const plan = mr.pick(PRICE_PLANS.filter((p) => p.code !== l.plan.code));
      changes.push({ msisdn_e164: toE164(c.national), field: "Priceplan", from: l.plan.code, to: plan.code });
      l.plan = plan;
    } else {
      const end = addMonths(l.endDate < m2Date ? m2Date : l.endDate, 24);
      changes.push({ msisdn_e164: toE164(c.national), field: "Contract End Date", from: iso(l.endDate), to: iso(end) });
      Object.assign(l, { endDate: end, term: 24, status: "InContract", monthsBucket: monthsBucket(end, m2Date) });
    }
    changedLines.set(c, { ...c, line: l, endFormat: "date" });
  }

  // New lines: 15 on existing accounts, the rest on new customers (1–3 lines each).
  const newLines: CLine[] = [];
  const regTaken = new Set(base.customers.map((c) => c.regNo));
  const acctTaken = new Set(base.accounts.map((a) => a.accountNo));
  const existingAccounts = mr.sample(base.accounts.filter((a) => !sentinelIds.has(a.customerId)), nNewExisting);
  const makeLine = (accountNo: number): Line => {
    const plan = mr.pick(PRICE_PLANS);
    const end = addDays(m2Date, mr.int(400, 1000));
    return { idx: -1, accountNo, mobile: makeMobile(mr, phones), term: 24, endDate: end, status: "InContract", monthsBucket: monthsBucket(end, m2Date), plan, device: null, chg: Math.round((150 + mr.next() * 600) * 100) / 100, bam: "N", kind: "future" };
  };
  for (const a of existingAccounts) {
    const c = cust.get(a.customerId)!;
    newLines.push({ line: makeLine(a.accountNo), customerId: c.id, regNo: a.regNoShown, name: a.displayName, dealer: a.dealerCode, segment: c.segment, phoneFormat: "stripped", national: "", endFormat: "date" });
  }
  const companyTaken = new Set(base.customers.map((c) => c.company.normalised));
  const newCompanies = makeCompanies(mr, Math.ceil((nNew - nNewExisting) / 2), companyTaken);
  // Each new customer takes 1–3 lines, so the first draw can run short: top up on demand from a
  // separate stream (seeds whose first draw was enough keep their exact output).
  const moreCompanies = mr.fork("more_new_companies");
  const newCustomerAccounts: { account_no: number; reg_no: string; name: string; lines: number }[] = [];
  let ci = 0;
  while (newLines.length < nNew) {
    if (ci >= newCompanies.length) newCompanies.push(...makeCompanies(moreCompanies, 1, companyTaken));
    const company = newCompanies[ci++];
    let accountNo: number;
    do accountNo = mr.int(30_000_000, 89_999_999);
    while (acctTaken.has(accountNo));
    acctTaken.add(accountNo);
    const regNo = makeRegNo(mr, company.legalSuffix === "CC" ? "23" : "07", regTaken);
    const k = Math.min(nNew - newLines.length, mr.int(1, 3));
    for (let j = 0; j < k; j++) {
      newLines.push({ line: makeLine(accountNo), customerId: 100_000 + ci, regNo, name: company.name, dealer: "KC-VS01", segment: "SME", phoneFormat: "stripped", national: "", endFormat: "date" });
    }
    newCustomerAccounts.push({ account_no: accountNo, reg_no: regNo, name: company.name, lines: k });
  }
  for (const n of newLines) n.national = n.line.mobile;

  // Assemble month 2: unchanged + changed + new, minus removed; then defects and duplicates.
  type M2Row = { c: CLine; cells: CellIn[]; tag: "unchanged" | "changed" | "new" | "duplicate" | "phone_defect" | "ambiguous_date" };
  let m2: M2Row[] = [];
  for (const c of clines) {
    if (removedSet.has(c)) continue;
    const ch = changedLines.get(c);
    if (ch) m2.push({ c: ch, cells: rowFor(ch), tag: "changed" });
    else m2.push({ c, cells: rowFor(c), tag: "unchanged" });
  }
  const phoneSet = new Set(phoneDefects);
  const ambiguousSet = new Set(ambiguous);
  for (const r of m2) {
    if (phoneSet.has(r.c)) {
      r.cells = rowFor(r.c, { Msisdn: driftPhone(mr, r.c.national) });
      r.tag = "phone_defect";
    } else if (ambiguousSet.has(r.c)) {
      // dd/mm vs mm/dd with both parts ≤ 12: the true date cannot be known from the file.
      const d = r.c.line.endDate;
      const mm = d.getUTCMonth() + 1;
      let dd = ((d.getUTCDate() - 1) % 12) + 1;
      if (dd === mm) dd = (dd % 12) + 1;
      const p2 = (n: number) => String(n).padStart(2, "0");
      r.cells = rowFor(r.c, { "Contract End Date": `${p2(dd)}/${p2(mm)}/${d.getUTCFullYear()}` });
      r.tag = "ambiguous_date";
    }
  }
  for (const n of newLines) m2.push({ c: n, cells: rowFor(n), tag: "new" });
  m2 = mr.shuffle(m2);
  const dupSources = mr.sample(m2.filter((r) => r.tag === "unchanged"), 30);
  for (const src of dupSources) {
    const at = mr.int(0, m2.length);
    m2.splice(at, 0, { c: src.c, cells: [...src.cells], tag: "duplicate" });
  }
  const m2Rows = m2.map((r) => r.cells);

  const month2 = newWorkbook("Kopano Connect BI export");
  addSheet(month2, { name: "vsam base raw", headers: [...C_COLUMNS], rows: m2Rows, dateFormats: { 7: "yyyy-mm-dd" } });

  // Drift: one column renamed, one added.
  const salesReps = Array.from({ length: 4 }, () => makePerson(mr).full);
  const driftHeaders = [...C_COLUMNS.map((h) => (h === "Contract End Date" ? "Contract_End" : h)), "Sales_Rep"];
  const drift = newWorkbook("Kopano Connect BI export");
  addSheet(drift, { name: "vsam base raw", headers: driftHeaders, rows: m2Rows.map((r) => [...r, mr.pick(salesReps)]), dateFormats: { 7: "yyyy-mm-dd" } });

  // ── Agent contact sheets (overlapping, conflicting) ──
  const cr = root.fork("contacts");
  const agentNames = [makePerson(cr), makePerson(cr), makePerson(cr)];
  const contactPool = cr.sample(base.customers, 270);
  const assignment = new Map<number, number[]>();
  contactPool.forEach((c, i) => {
    const owners = i < 12 ? [0, 1, 2] : i < 57 ? cr.sample([0, 1, 2], 2) : [cr.int(0, 2)];
    assignment.set(c.id, owners);
  });
  const sheetRows: CellIn[][][] = [[], [], []];
  let conflicting = 0;
  for (const c of contactPool) {
    const owners = assignment.get(c.id)!;
    const a = base.accounts.find((x) => x.customerId === c.id)!;
    if (owners.length > 1) conflicting++;
    owners.forEach((o) => {
      const person: Person = makePerson(cr);
      const mobile = makeMobile(cr, phones);
      const role = cr.pick(["owner", "bookkeeper", "receptionist", "office manager", "director"]);
      const email = cr.chance(0.7) ? personEmail(person) : null;
      const spoke = addDays(parseIso(MONTH1), -cr.int(3, 120));
      if (o === 0) sheetRows[0].push([a.accountNo, a.displayName, `${person.full} (${role})`, Number(mobile), email, spoke, cr.pick(["", "prefers WhatsApp", "call after 2pm", "renewal due soon", ""])]);
      else if (o === 1)
        sheetRows[1].push([cr.chance(0.7) ? a.accountNo : null, a.displayName.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()), person.full, `${mobile.slice(0, 3)} ${mobile.slice(3, 6)} ${mobile.slice(6)}`, cr.chance(0.3) ? bracketStyle(makeLandline(cr, phones)) : null, email, cr.pick(["", "bookkeeper answers", "owner travels a lot", ""])]);
      else sheetRows[2].push([normaliseCompanyName(a.displayName), `${person.first} ${person.last}`, cr.chance(0.5) ? `+27${mobile.slice(1)}` : mobile, email, `${spoke.getUTCDate()}/${spoke.getUTCMonth() + 1}/${spoke.getUTCFullYear()}`]);
    });
  }
  const contacts = newWorkbook("Kopano agents");
  addSheet(contacts, { name: agentNames[0].first, headers: ["Account No", "Company", "Contact Person", "Cell", "Email", "Last Spoke", "Notes"], rows: cr.shuffle(sheetRows[0]), dateFormats: { 5: "yyyy-mm-dd" } });
  addSheet(contacts, { name: agentNames[1].first === agentNames[0].first ? `${agentNames[1].first} ${agentNames[1].last[0]}` : agentNames[1].first, headers: ["Acc #", "Customer", "Name", "Mobile", "Landline", "E-mail", "Notes"], rows: cr.shuffle(sheetRows[1]) });
  addSheet(contacts, { name: `${agentNames[2].first} ${agentNames[2].last}`.slice(0, 31), headers: ["Company Name", "Decision Maker", "Number", "Email Address", "Date"], rows: cr.shuffle(sheetRows[2]) });

  // ── Legal opt-out list: company names only, with spelling variants (RD-11) ──
  const lr = root.fork("optouts");
  const optCustomers = lr.sample(base.customers.filter((c) => !sentinelIds.has(c.id)), 37);
  const misspell = (s: string) => {
    const i = lr.int(1, Math.max(1, s.length - 3));
    return s[i] === " " || s[i + 1] === " " ? s : `${s.slice(0, i)}${s[i + 1]}${s[i]}${s.slice(i + 2)}`;
  };
  const variant = (name: string): string => {
    const core = name.replace(/\s*\(PTY\) LTD$/, "").replace(/\s+CC$/, "");
    const title = core.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
    return lr.pick([
      title,
      `${title} (Pty) Ltd`,
      `${title} Pty Ltd`,
      `${core}`,
      misspell(title),
      title.replace(/ & /g, " and "),
      `${title}.`,
      `${title.replace(/ /, "  ")}`,
    ]);
  };
  const optRows: CellIn[][] = [];
  const matches: { listed_name: string; status: string; customer_reg_no: string; account_nos: number[] }[] = [];
  for (const c of optCustomers) {
    const listed = variant(base.accounts.find((a) => a.customerId === c.id)!.displayName);
    const status = lr.chance(0.8) ? "Opted out" : "Under legal review";
    optRows.push([listed, addDays(parseIso(MONTH1), -lr.int(10, 400)), status, lr.pick(["Complaint after SMS", "Asked not to be called", "Email request", "Referred by Network", ""])]);
    matches.push({ listed_name: listed, status, customer_reg_no: c.regNo, account_nos: base.accounts.filter((a) => a.customerId === c.id).map((a) => a.accountNo) });
  }
  // Not customers in month 1 or month 2 (companyTaken holds both).
  const notCustomers = makeCompanies(lr, 3, companyTaken);
  for (const n of notCustomers) optRows.push([n.name.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()), addDays(parseIso(MONTH1), -lr.int(10, 400)), "Opted out", "Not a current customer"]);
  const optouts = newWorkbook("Kopano Legal");
  addSheet(optouts, { name: "Opt-outs", headers: ["Company", "Date Logged", "Status", "Notes"], rows: lr.shuffle(optRows), dateFormats: { 1: "dd/mm/yyyy" } });

  // ── Expected post-import state ──
  const m1Valid = new Set(clines.map(validKey).filter((k): k is string => k !== null));
  const m2RowNo = (pred: (r: M2Row) => boolean) => m2.map((r, i) => (pred(r) ? i + 2 : -1)).filter((n) => n > 0);
  const m2Active = new Set(m2.map((r) => validKey(r.c)).filter((k): k is string => k !== null));
  const customersM1 = new Set(clines.map((c) => c.customerId)).size;
  const quarantine = [
    ...m2RowNo((r) => r.tag === "ambiguous_date").map((row) => ({ row, reason: "ambiguous_date" })),
    ...m2RowNo((r) => r.c.phoneFormat === "zero" && r.tag !== "duplicate").map((row) => ({ row, reason: "invalid_phone" })),
    ...m2RowNo((r) => r.c.endFormat === "epoch" && r.tag !== "duplicate").map((row) => ({ row, reason: "epoch_date" })),
  ].sort((x, y) => x.row - y.row);

  const expected: ExpectedMonth2 = {
    bundle: "bundle_c",
    version,
    seed,
    export_dates: { month1: MONTH1, month2: MONTH2 },
    identity: {
      customer_key: "Reg No when present (about 92% of rows); otherwise Account No plus the normalised Customer Name. One customer can have several Account Nos.",
      line_key: "Msisdn normalised to E.164 (+27...). Landlines are lines too but cannot receive SMS/WhatsApp.",
    },
    month1: {
      file_rows: clines.length,
      customers: customersM1,
      accounts: base.accounts.length,
      lines: m1Valid.size,
      reg_no_blank_rows: clines.filter((c) => c.regNo === null).length,
      invalid_phone_rows: clines.map((c, i) => (c.phoneFormat === "zero" ? i + 2 : -1)).filter((n) => n > 0),
      landline_rows: clines.filter((c) => c.phoneFormat === "landline").length,
      phone_as_number_rows: clines.filter((c) => c.phoneFormat === "stripped" || c.phoneFormat === "landline" || c.phoneFormat === "msisdn").length,
      epoch_rows: clines.map((c, i) => (c.endFormat === "epoch" ? i + 2 : -1)).filter((n) => n > 0),
      us_date_string_rows: clines.filter((c) => c.endFormat === "us_string").length,
      stale_incontract_rows: clines.filter((c) => c.line.status === "InContract" && c.line.endDate < parseIso(MONTH1)).length,
    },
    month2: {
      file_rows: m2.length,
      customers_after: customersM1 + newCustomerAccounts.length,
      new_customers: newCustomerAccounts.length,
      new_customer_accounts: newCustomerAccounts,
      lines_after_active: m2Active.size,
      lines_total_including_inactive: m1Valid.size + newLines.length,
      lines_new: newLines.length,
      lines_new_for_existing_customers: nNewExisting,
      lines_changed: changes.length,
      lines_removed: removed.length,
      duplicate_rows: 30,
      phone_defect_rows: phoneDefects.length,
      ambiguous_date_rows: ambiguous.length,
      changed: changes,
      removed_msisdns: removed.map((c) => toE164(c.national)),
      new_msisdns: newLines.map((n) => toE164(n.national)),
      duplicate_row_numbers: m2RowNo((r) => r.tag === "duplicate"),
      phone_defect_row_numbers: m2RowNo((r) => r.tag === "phone_defect"),
      ambiguous_date_row_numbers: m2RowNo((r) => r.tag === "ambiguous_date"),
      quarantine_expected: quarantine,
      rerun_same_file: "no changes (M6)",
    },
    drift: {
      file: C_FILES.drift,
      renamed: { from: "Contract End Date", to: "Contract_End" },
      added: ["Sales_Rep"],
      expect: "The import fails loudly naming the column, and writes no partial data (M7).",
    },
    sentinels: sentinelCustomers.map((c) => {
      const ls = clines.filter((x) => x.customerId === c.id);
      return {
        account_no: ls[0].line.accountNo,
        account_nos: [...new Set(ls.map((x) => x.line.accountNo))],
        reg_no: c.regNo,
        name: ls[0].name,
        lines: ls.length,
        msisdns: ls.map((x) => toE164(x.national)),
      };
    }),
    optouts: {
      listed: optRows.length,
      matches,
      not_customers: notCustomers.map((n) => n.name),
    },
    contacts: {
      agents: agentNames.map((p) => p.full),
      customers_in_sheets: contactPool.length,
      in_two_or_more_sheets: conflicting,
      in_all_three: 12,
    },
  };

  return { month1, contacts, optouts, month2, drift, expected, readme: C_README, handoff };
}
