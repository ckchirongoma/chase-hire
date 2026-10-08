import type { Workbook } from "exceljs";
import { D_CODES, type BundleAAnswerKey, type DefectEntry } from "./answer-key";
import { generateBase, type Base, type Line } from "./base";
import { addDays, iso, parseIso, utc, weekdaysOf } from "./dates";
import {
  bracketStyle,
  companyEmail,
  isMobileNational,
  makeCompanies,
  makeLandline,
  makeMobile,
  makePerson,
  personEmail,
  type Person,
} from "./names";
import { createSynthRng, type SynthRng } from "./rng";
import { addSheet, newWorkbook, type CellIn } from "./xlsx";

/**
 * Bundle A (BA Part 1): kopano_vsam_extract.xlsx with every D01–D23 defect planted, plus the
 * internal answer key with exact counts and row identifiers (docs/11, docs/06 gap key).
 */

export const BUNDLE_A_FILE = "kopano_vsam_extract.xlsx";
export const SHEET = {
  base: "vsam base raw",
  worksheet: "worksheet",
  dialler: "dialler September stats",
  interval: "interval log",
} as const;

export const BASE_COLUMNS = [
  "Account No", "Msisdn", "Customer Name", "dealer_code", "Telemetry", "Bam Flag", "Region", "Channel", "Segment", "RSM", "AM",
  "Contract Term", "Contract End Date", "Contract Status", "Month Remaining In Contract", "Priceplan Category", "Priceplan",
  "Priceplan Name", "Package", "Package Name", "Tariff", "Tariff Name", "Device Type", "Device Manufacturer", "Device Model", "chg_subs",
] as const;

export const WORKSHEET_COLUMNS = [
  "Account No", "Customer Name", "Account Holder Name", "Contact", "Call Status", null, "Status (clean)", "Email", "date contacted",
  "Date digits (helper)", "Date (clean)", "Completed Allocated Blocks? (4/4)", "Out Of Contract", "Consultant", "Next Action",
  "Action Required", "Application Status", "Comment Status", "Reason", "QTY",
] as const;

export const DIALLER_COLUMNS = [
  "Agent", "Login Time", "Talk Time", "Wrap Time", "Not Ready Time", "Outbound Calls", "Inbound Calls", "Answered Calls", "Abandoned Calls", "Avg Handle Time",
] as const;

/** Trailing spaces in several headers are a planted defect (D21). */
export const INTERVAL_COLUMNS = ["Date", "Agent ", "Calls ", "Connected", "Opportunities ", "Sales", "Target ", "Day Status "] as const;
export const TARGET_STRING = "104 / 52 / 21 / 6";
export const TARGET_SALES_PER_AGENT_DAY = 6;

/** Real-extract figures this generator must never reproduce exactly (structure only, never values). */
const AVOID = {
  accounts: 1377, lines: 5114, stale: 107, worksheet: 127, calls: 1687, connected: 865, opportunities: 76, sales: 22, dayStatus: 8,
  holderZero: 69, windowLines: 473, windowAccounts: 224, windowCharges: 158855,
};

const pickAvoid = (rng: SynthRng, lo: number, hi: number, avoid: number) => {
  for (;;) {
    const v = rng.int(lo, hi);
    if (v !== avoid) return v;
  }
};

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

function misspell(rng: SynthRng, full: string): string {
  const [first, ...rest] = full.split(" ");
  const last = rest.join(" ");
  // A transposition needs at least 4 letters (e.g. "Tau" or "Nel" has no inner pair to swap).
  if (last.length < 4) return `${first} ${last}${last[last.length - 1] ?? "h"}`;
  for (let g = 0; g < 50; g++) {
    const i = rng.int(1, last.length - 3);
    const a = last[i];
    const b = last[i + 1];
    if (a === b || a === " " || b === " ") continue;
    return `${first} ${last.slice(0, i)}${b}${a}${last.slice(i + 2)}`;
  }
  return `${first} ${last}h`;
}

const WINDOW_DAYS = 90;

// ───────────────────────── Worksheet row model ─────────────────────────

type ContactKind = "bracket_mobile" | "bracket_landline" | "stripped_mobile" | "stripped_landline" | "zero" | "other_string";
type DateKind = "us" | "padded_ambiguous" | "yyyy_dd_mm" | "impossible" | "excel_date" | "blank";
type BlocksKind = "date" | "text_zero" | "blank";

interface WsRow {
  accountNo: number;
  customerName: string;
  inBase: boolean;
  holder: string | 0;
  contactKind: ContactKind;
  contact: string | number;
  /** The national number behind the contact cell (null for the 0 placeholder). */
  contactNational: string | null;
  callStatus: string;
  notes: string;
  statusClean: string;
  email: string | null;
  dateKind: DateKind;
  dateContacted: string | Date | null;
  dateDigits: number | null;
  dateClean: Date | { error: "#VALUE!" } | null;
  blocksKind: BlocksKind;
  blocks: Date | string | null;
  oocShown: number;
  oocBase: number | null;
  applicationStatus: string | null;
  commentStatus: string | null;
}

const CALL_STATUS = {
  callback: "Call back / Follow up",
  quote: "Engaged Requested quote",
} as const;

const OTHER_STATUSES: readonly (readonly [string, number])[] = [
  ["Voicemail / Email sent ", 18],
  ["Voicemail, email sent", 9],
  ["Voicemail", 6],
  ["No answer", 22],
  ["Not interested", 14],
  ["Not interested ", 4],
  ["Wrong number", 7],
  ["Number not in service", 4],
  ["", 16],
];

function cleanStatus(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (!s) return "";
  if (s.startsWith("voicemail")) return "Voicemail";
  if (s.startsWith("call back")) return "Callback";
  if (s.startsWith("engaged requested quote")) return "Quote";
  if (s.startsWith("not interested")) return "Not Interested";
  if (s.startsWith("no answer")) return "No Answer";
  return "Invalid Number";
}

const DEAD = new Set(["No Answer", "Invalid Number", "Not Interested", ""]);

const NOTES: Record<string, readonly string[]> = {
  Callback: ["Asked to call back", "Decision maker out, call back", "Busy, follow up later", "Bookkeeper says call back", "Call back re upgrade"],
  Quote: ["Wants quote for 3 lines", "Requested pricing on upgrade", "Send quote for new devices", "Quote for data bundles", "Wants quote, compare with current deal"],
  Voicemail: ["Left voicemail", "VM + email", "Voicemail, sent email"],
  "No Answer": ["No answer", "Rang out", "No answer x2"],
  "Not Interested": ["Happy with current deal", "Not interested at the moment", "Moving to another provider", "Too expensive"],
  "Invalid Number": ["Wrong number", "Number does not exist", "Spoke to wrong company"],
  "": [""],
};

function digitsOf(s: string): number | null {
  const d = s.replace(/\D/g, "");
  return d ? Number(d) : null;
}

/** What a d/m/yyyy-locale "clean" formula makes of the string (often wrong, sometimes an error). */
function localeParse(s: string): Date | { error: "#VALUE!" } {
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
    return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? utc(y, m, d) : { error: "#VALUE!" };
  }
  const ymd = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (ymd) {
    const [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
    return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? utc(y, m, d) : { error: "#VALUE!" };
  }
  return { error: "#VALUE!" };
}

const two = (n: number) => String(n).padStart(2, "0");

function contactDate(rng: SynthRng): Date {
  // Activity runs from mid-August to the end of September 2026.
  return addDays(utc(2026, 8, 17), rng.int(0, 44));
}

function makeDateValue(rng: SynthRng, kind: DateKind): { value: string | Date | null } {
  switch (kind) {
    case "blank":
      return { value: null };
    case "excel_date":
      return { value: contactDate(rng) };
    case "us": {
      // m/d/yyyy without zero padding; August/September, so the month is one digit.
      const d = contactDate(rng);
      return { value: `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}` };
    }
    case "padded_ambiguous": {
      // dd/mm/yyyy with both parts ≤ 12: 11/09/2026 is 11 Sep or 9 Nov.
      const m = rng.pick([8, 9]);
      const day = rng.int(1, 12);
      return { value: `${two(day)}/${two(m)}/2026` };
    }
    case "yyyy_dd_mm": {
      const m = rng.pick([8, 9]);
      const day = rng.int(1, 12);
      return { value: `2026/${two(day)}/${two(m)}` };
    }
    case "impossible": {
      const m = rng.pick([8, 9]);
      const day = rng.int(13, 28);
      return { value: `2026/${two(day)}/${two(m)}` };
    }
  }
}

function counts<T extends string>(total: number, shares: readonly (readonly [T, number])[]): T[] {
  // Largest-remainder apportionment, then the list in key order (callers shuffle).
  const raw = shares.map(([k, s]) => ({ k, exact: total * s }));
  const base = raw.map((r) => ({ k: r.k, n: Math.floor(r.exact), rem: r.exact - Math.floor(r.exact) }));
  let left = total - base.reduce((s, b) => s + b.n, 0);
  for (const b of [...base].sort((x, y) => y.rem - x.rem)) {
    if (left <= 0) break;
    b.n++;
    left--;
  }
  return base.flatMap((b) => Array.from({ length: b.n }, () => b.k));
}

// ───────────────────────── Build ─────────────────────────

export interface BundleA {
  workbook: Workbook;
  answerKey: BundleAAnswerKey;
  base: Base;
  /** Fictional people used across the sheets (for bundle B's agents table). */
  people: { agents: Person[]; am: Person; rsm: Person; consultant: Person };
  worksheetRows: WsRow[];
}

export function buildBundleA(seed: number, version: string): BundleA {
  const root = createSynthRng(seed).fork("bundle_a");
  const exportDate = parseIso("2026-10-07");

  // People: four VSAM agents (one is the worksheet consultant), the AM and RSM, other dialler users.
  const pr = root.fork("people");
  const taken = new Set<string>();
  const agents = [makePerson(pr, taken), makePerson(pr, taken), makePerson(pr, taken), makePerson(pr, taken)];
  const am = makePerson(pr, taken);
  const rsm = makePerson(pr, taken);
  const others = Array.from({ length: 12 }, () => makePerson(pr, taken));
  const consultant = agents[0];
  const amMisspelt = misspell(pr, am.full);

  // ── vsam base raw ──
  // Redrawn (from a fresh stream) in the rare case a derived figure equals the real extract's.
  const drawBase = (br: SynthRng) =>
    generateBase(br, {
      accounts: pickAvoid(br, 1335, 1365, AVOID.accounts),
      lineRange: [4920, 5080],
      maxLinesPerAccount: 70,
      exactDuplicatePairs: 5,
      variantDuplicatePairs: 2,
      staleInContract: pickAvoid(br, 98, 112, AVOID.stale),
      epochLines: 5,
      windowShare: 0.09,
      oocShare: 0.33,
      exportDate: iso(exportDate),
      regNoShare: 0,
    });
  const windowOf = (b: Base) => {
    const end = addDays(exportDate, WINDOW_DAYS);
    const lines = b.lines.filter((l) => l.endDate >= exportDate && l.endDate <= end);
    return { lines: lines.length, accounts: new Set(lines.map((l) => l.accountNo)).size, charges: Math.round(lines.reduce((s, l) => s + (l.chg ?? 0), 0)) };
  };
  let base = drawBase(root.fork("base"));
  for (let attempt = 1; attempt < 50; attempt++) {
    const w = windowOf(base);
    if (base.lines.length !== AVOID.lines && w.lines !== AVOID.windowLines && w.accounts !== AVOID.windowAccounts && w.charges !== AVOID.windowCharges) break;
    base = drawBase(root.fork(`base-${attempt}`));
  }
  const accountName = new Map(base.accounts.map((a) => [a.accountNo, a.displayName]));
  const accountDealer = new Map(base.accounts.map((a) => [a.accountNo, a.dealerCode]));
  const customerOf = new Map(base.accounts.map((a) => [a.accountNo, base.customers[a.customerId - 1]]));
  const baseRows: CellIn[][] = base.lines.map((l) => [
    l.accountNo,
    Number(`27${l.mobile.slice(1)}`),
    accountName.get(l.accountNo)!,
    accountDealer.get(l.accountNo)!,
    "N",
    l.bam,
    "NAT",
    "VSAM",
    customerOf.get(l.accountNo)!.segment,
    rsm.full,
    amMisspelt,
    l.term,
    l.endDate,
    l.status,
    l.monthsBucket,
    l.plan.category,
    l.plan.code,
    l.plan.name,
    l.plan.packageCode,
    l.plan.packageName,
    l.plan.tariffCode,
    l.plan.tariffName,
    l.device?.type ?? null,
    l.device?.manufacturer ?? null,
    l.device?.model ?? null,
    l.chg,
  ]);
  const baseRowOf = (l: Line) => l.idx + 2;

  const linesByAccount = new Map<number, Line[]>();
  for (const l of base.lines) linesByAccount.set(l.accountNo, [...(linesByAccount.get(l.accountNo) ?? []), l]);
  const oocCount = (acct: number) => (linesByAccount.get(acct) ?? []).filter((l) => l.status === "Out Of Contract").length;

  // ── worksheet ──
  const wr = root.fork("worksheet");
  const nWs = pickAvoid(wr, 122, 128, AVOID.worksheet);
  const nAbsent = 4;
  const oocAccounts = base.accounts.filter((a) => oocCount(a.accountNo) > 0).map((a) => a.accountNo);
  const matched = wr.sample(oocAccounts, nWs - nAbsent);
  const absentCompanies = makeCompanies(wr, nAbsent, new Set(base.customers.map((c) => c.company.normalised)));
  const acctNos = new Set(base.accounts.map((a) => a.accountNo));
  const absent = absentCompanies.map((c) => {
    let n: number;
    do n = wr.int(30_000_000, 89_999_999);
    while (acctNos.has(n));
    acctNos.add(n);
    return { accountNo: n, name: c.name };
  });

  const order = wr.shuffle([
    ...matched.map((a) => ({ accountNo: a, name: accountName.get(a)!, inBase: true })),
    ...absent.map((a) => ({ ...a, inBase: false })),
  ]);
  const N = order.length;

  const holderZeroCount = Math.round(N * 0.54) === AVOID.holderZero ? AVOID.holderZero + 1 : Math.round(N * 0.54);
  const holderZero = new Set(wr.sample([...Array(N).keys()], holderZeroCount));
  const emailBlank = new Set(wr.sample([...Array(N).keys()], Math.round(N * 0.55)));
  const contactKinds = wr.shuffle(
    counts<ContactKind>(N, [
      ["bracket_mobile", 0.62],
      ["bracket_landline", 0.08],
      ["stripped_mobile", 0.1],
      ["stripped_landline", 0.02],
      ["zero", 0.13],
      ["other_string", 0.05],
    ]),
  );
  const nStrings = Math.round((N * 111) / 143);
  const nDates = Math.round((N * 16) / 143);
  const nImpossible = 3;
  const nUs = Math.round(nStrings * 0.5);
  const nPadded = Math.round(nStrings * 0.22);
  const nYdm = nStrings - nUs - nPadded - nImpossible;
  const dateKinds: DateKind[] = [
    ...Array<DateKind>(nUs).fill("us"),
    ...Array<DateKind>(nPadded).fill("padded_ambiguous"),
    ...Array<DateKind>(nYdm).fill("yyyy_dd_mm"),
    ...Array<DateKind>(nImpossible).fill("impossible"),
    ...Array<DateKind>(nDates).fill("excel_date"),
    ...Array<DateKind>(N - nStrings - nDates).fill("blank"),
  ];
  const blocksKinds = wr.shuffle(
    counts<BlocksKind>(N, [
      ["date", 0.6],
      ["text_zero", 0.3],
      ["blank", 0.1],
    ]),
  );

  // Call statuses: exactly 9 undated callbacks (D14) and 10 quote requests (D15).
  const statuses = wr.shuffle([
    ...Array<string>(9).fill(CALL_STATUS.callback),
    ...Array<string>(10).fill(CALL_STATUS.quote),
    ...Array.from({ length: N - 19 }, () => wr.weighted(OTHER_STATUSES)),
  ]);
  // Blank date contacted goes to rows with no call status first.
  const blankStatusIdx = statuses.map((s, i) => (s === "" ? i : -1)).filter((i) => i >= 0);
  const otherIdx = wr.shuffle(statuses.map((s, i) => (s === "" ? -1 : i)).filter((i) => i >= 0));
  const dateOrder = [...wr.shuffle(blankStatusIdx), ...otherIdx];
  const blanksFirst = dateKinds.filter((k) => k === "blank");
  const nonBlank = wr.shuffle(dateKinds.filter((k) => k !== "blank"));
  const dateKindByRow = new Array<DateKind>(N);
  dateOrder.forEach((rowIdx, i) => (dateKindByRow[rowIdx] = i < blanksFirst.length ? "blank" : nonBlank[i - blanksFirst.length]));

  const quoteRows = statuses.map((s, i) => (s === CALL_STATUS.quote ? i : -1)).filter((i) => i >= 0);
  const [processingRow, approvedRow] = wr.sample(quoteRows, 2);
  const doneRows = new Set(wr.sample([...Array(N).keys()], Math.round(N * 0.88)));
  const driftRows = new Set(wr.sample(order.map((o, i) => (o.inBase ? i : -1)).filter((i) => i >= 0), 5));
  // Two rows had the clean status column skipped when it was bolted on.
  const skippedClean = new Set(wr.sample(statuses.map((s, i) => (s ? i : -1)).filter((i) => i >= 0 && !quoteRows.includes(i)), 2));

  const phones = new Set(base.lines.map((l) => l.mobile));
  const wsRows: WsRow[] = order.map((o, i) => {
    const contactKind = contactKinds[i];
    let contact: string | number;
    let contactNational: string | null;
    switch (contactKind) {
      case "bracket_mobile":
        contactNational = makeMobile(wr, phones);
        contact = bracketStyle(contactNational);
        break;
      case "bracket_landline":
        contactNational = makeLandline(wr, phones);
        contact = bracketStyle(contactNational);
        break;
      case "stripped_mobile":
        contactNational = makeMobile(wr, phones);
        contact = Number(contactNational);
        break;
      case "stripped_landline":
        contactNational = makeLandline(wr, phones);
        contact = Number(contactNational);
        break;
      case "zero":
        contactNational = null;
        contact = 0;
        break;
      default: {
        contactNational = makeMobile(wr, phones);
        const n = contactNational;
        contact = wr.pick([`${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`, `+27 ${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`, `${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}`, `${n}`]);
      }
    }
    const holderPerson = makePerson(wr);
    const callStatus = statuses[i];
    const statusClean = skippedClean.has(i) ? "" : cleanStatus(callStatus);
    const noteKey = cleanStatus(callStatus);
    const dateKind = dateKindByRow[i];
    const { value: dateContacted } = makeDateValue(wr, dateKind);
    const dateDigits =
      dateContacted === null ? null : dateContacted instanceof Date ? Math.round(dateContacted.getTime() / 86_400_000 + 25569) : digitsOf(dateContacted);
    const dateClean = dateContacted === null ? null : dateContacted instanceof Date ? dateContacted : localeParse(dateContacted);
    const blocksKind = blocksKinds[i];
    const k = wr.int(1, 4);
    const blocks = blocksKind === "date" ? utc(2026, k, 4) : blocksKind === "text_zero" ? "0/4" : null;
    const oocBase = o.inBase ? oocCount(o.accountNo) : null;
    let oocShown = oocBase ?? wr.int(1, 4);
    if (driftRows.has(i) && oocBase !== null) {
      const delta = wr.pick([-2, -1, 1, 2]);
      oocShown = oocBase + delta < 0 ? oocBase + Math.abs(delta) : oocBase + delta;
    }
    const company = { name: o.name, slug: o.name.toLowerCase().replace(/[^a-z0-9]+/g, "") };
    return {
      accountNo: o.accountNo,
      customerName: o.name,
      inBase: o.inBase,
      holder: holderZero.has(i) ? 0 : holderPerson.full,
      contactKind,
      contact,
      contactNational,
      callStatus,
      notes: wr.pick(NOTES[noteKey] ?? [""]),
      statusClean,
      email: emailBlank.has(i) ? null : wr.chance(0.6) ? personEmail(holderPerson) : companyEmail({ ...company, normalised: "", legalSuffix: "" }, wr),
      dateKind,
      dateContacted,
      dateDigits,
      dateClean,
      blocksKind,
      blocks,
      oocShown,
      oocBase,
      applicationStatus: i === processingRow ? "Processing" : i === approvedRow ? "Approved" : null,
      commentStatus: doneRows.has(i) ? "DONE" : null,
    };
  });

  const wsSheetRows: CellIn[][] = wsRows.map((r) => [
    r.accountNo,
    r.customerName,
    r.holder,
    r.contact,
    r.callStatus || null,
    r.notes || null,
    r.statusClean || null,
    r.email,
    r.dateContacted,
    r.dateDigits,
    r.dateClean,
    r.blocks,
    r.oocShown,
    consultant.full,
    null,
    null,
    r.applicationStatus,
    r.commentStatus,
    "OUT OF CONTRACT",
    1,
  ]);

  // ── interval log + funnel (D21, D22) ──
  const days = weekdaysOf(2026, 9);
  const heritage = iso(utc(2026, 9, 24));
  const intervalAgent = (p: Person) => `${p.first} ${p.last[0].toUpperCase()}.`;
  const diallerAgent = (p: Person) => `${p.first}.${p.last}`.toLowerCase().replace(/\s+/g, "");
  type IRow = { date: Date; agent: Person; calls: number; connected: number; opps: number; sales: number; dayStatus: string | null; bookedOff: boolean };
  let irows: IRow[] = [];
  for (let attempt = 0; attempt < 500; attempt++) {
    const fr = root.fork(`funnel-${attempt}`);
    const leave = new Set(fr.sample(days.filter((d) => iso(d) !== heritage).flatMap((d) => agents.map((a) => `${iso(d)}|${a.full}`)), 3));
    const bin = (n: number, p: number) => {
      let k = 0;
      for (let j = 0; j < n; j++) if (fr.next() < p) k++;
      return k;
    };
    irows = days.flatMap((d) =>
      agents.map((a): IRow => {
        const off = iso(d) === heritage || leave.has(`${iso(d)}|${a.full}`);
        if (off) return { date: d, agent: a, calls: 0, connected: 0, opps: 0, sales: 0, dayStatus: null, bookedOff: true };
        const calls = Math.max(4, Math.round(21 + 6 * fr.normal()));
        const connected = bin(calls, 0.512);
        const opps = bin(connected, 0.087);
        const sales = bin(opps, 0.29);
        return { date: d, agent: a, calls, connected, opps, sales, dayStatus: null, bookedOff: false };
      }),
    );
    const t = irows.reduce((s, r) => ({ calls: s.calls + r.calls, connected: s.connected + r.connected, opps: s.opps + r.opps, sales: s.sales + r.sales }), { calls: 0, connected: 0, opps: 0, sales: 0 });
    const ok =
      t.calls >= 1650 && t.calls <= 1760 && t.calls !== AVOID.calls &&
      t.connected / t.calls >= 0.495 && t.connected / t.calls <= 0.53 && t.connected !== AVOID.connected &&
      t.opps >= 68 && t.opps <= 82 && t.opps !== AVOID.opportunities &&
      t.sales >= 19 && t.sales <= 25 && t.sales !== AVOID.sales;
    if (ok) {
      // Day Status is sparse (docs/11): a seeded handful of booked-off and working rows. The total
      // is drawn per bundle and never equals the real extract's count.
      const off = irows.filter((r) => r.bookedOff);
      const work = irows.filter((r) => !r.bookedOff);
      const nOff = fr.int(2, Math.min(5, off.length));
      const nWork = pickAvoid(fr, nOff + 2, nOff + 7, AVOID.dayStatus) - nOff;
      for (const r of fr.sample(off, nOff)) r.dayStatus = iso(r.date) === heritage ? "Public Holiday" : "Leave";
      const labels = ["Training", "Half Day", "System Down", "Team Meeting", "Site Visit", "Sick (pm)", "Coaching"];
      fr.sample(work, nWork).forEach((r) => (r.dayStatus = fr.pick(labels)));
      break;
    }
    if (attempt === 499) throw new Error("bundle A: could not draw a funnel in range");
  }
  const intervalRows: CellIn[][] = irows.map((r) => [r.date, intervalAgent(r.agent), r.calls, r.connected, r.opps, r.sales, TARGET_STRING, r.dayStatus]);
  const funnel = irows.reduce((s, r) => ({ calls: s.calls + r.calls, connected: s.connected + r.connected, opps: s.opps + r.opps, sales: s.sales + r.sales }), { calls: 0, connected: 0, opps: 0, sales: 0 });

  // ── dialler September stats (D19, D20) ──
  const dr = root.fork("dialler");
  const hms = (secs: number) => `${Math.floor(secs / 3600)}:${two(Math.floor((secs % 3600) / 60))}:${two(secs % 60)}`;
  const callsByAgent = new Map(agents.map((a) => [a.full, irows.filter((r) => r.agent === a).reduce((s, r) => s + r.calls, 0)]));
  const diallerUsers = dr.shuffle([
    ...agents.map((a) => ({ name: diallerAgent(a), outbound: Math.round(callsByAgent.get(a.full)! * (1.05 + dr.next() * 0.15)), kind: "vsam_agent" as const })),
    { name: am.full, outbound: dr.int(40, 120), kind: "account_manager" as const },
    { name: "test 23", outbound: dr.int(2, 6), kind: "test_user" as const },
    { name: "Dialler Support", outbound: 0, kind: "system_user" as const },
    ...others.map((p) => ({ name: p.full, outbound: dr.int(250, 1900), kind: "other_team" as const })),
  ]);
  const diallerRows: CellIn[][] = diallerUsers.map((u) => {
    const login = u.kind === "system_user" ? dr.int(600, 4000) : u.kind === "test_user" ? dr.int(300, 1200) : dr.int(90, 170) * 3600 + dr.int(0, 3599);
    const answered = Math.round(u.outbound * (0.45 + dr.next() * 0.1));
    const talk = answered * dr.int(90, 240);
    const wrap = answered * dr.int(15, 60);
    const inbound = u.kind === "other_team" ? dr.int(0, 400) : dr.int(0, 12);
    return [u.name, hms(login), hms(talk), hms(wrap), hms(Math.max(0, Math.round(login * (0.1 + dr.next() * 0.2)))), u.outbound, inbound, answered, dr.int(0, 9), answered ? hms(Math.round((talk + wrap) / answered)) : "0:00:00"];
  });

  // ── workbook ──
  const wb = newWorkbook("Kopano Connect BI export");
  addSheet(wb, { name: SHEET.base, headers: [...BASE_COLUMNS], rows: baseRows, dateFormats: { 12: "yyyy-mm-dd" } });
  addSheet(wb, { name: SHEET.worksheet, headers: [...WORKSHEET_COLUMNS], rows: wsSheetRows, dateFormats: { 8: "m/d/yyyy", 10: "yyyy-mm-dd", 11: "d-mmm" } });
  addSheet(wb, { name: SHEET.dialler, headers: [...DIALLER_COLUMNS], rows: diallerRows });
  addSheet(wb, { name: SHEET.interval, headers: [...INTERVAL_COLUMNS], rows: intervalRows, dateFormats: { 0: "yyyy-mm-dd" } });

  // ── answer key ──
  const wsRowNo = (i: number) => i + 2;
  const rowsWhere = (pred: (r: WsRow) => boolean) => wsRows.map((r, i) => (pred(r) ? wsRowNo(i) : -1)).filter((n) => n > 0);
  const windowEnd = addDays(exportDate, WINDOW_DAYS);
  const windowLines = base.lines.filter((l) => l.endDate >= exportDate && l.endDate <= windowEnd);
  const windowAccounts = new Set(windowLines.map((l) => l.accountNo));
  const wsByAccount = new Map(wsRows.map((r) => [r.accountNo, r]));
  const windowInWs = [...windowAccounts].filter((a) => wsByAccount.has(a));
  const hasAnyContact = (r: WsRow) => r.contactKind !== "zero" || r.email !== null;
  const usableMobile = (r: WsRow) => r.contactNational !== null && isMobileNational(r.contactNational);
  const windowWithContact = windowInWs.filter((a) => hasAnyContact(wsByAccount.get(a)!));
  const windowWithMobile = windowInWs.filter((a) => usableMobile(wsByAccount.get(a)!));
  const windowCharges = Math.round(windowLines.reduce((s, l) => s + (l.chg ?? 0), 0) * 100) / 100;
  const stale = base.lines.filter((l) => l.status === "InContract" && l.endDate < exportDate);
  const epoch = base.lines.filter((l) => l.kind === "epoch");
  const unknownBucket = base.lines.filter((l) => l.monthsBucket === "Unknown");
  const ooc = base.lines.filter((l) => l.status === "Out Of Contract");
  const lpa = [...linesByAccount.values()].map((ls) => ls.length).sort((a, b) => a - b);
  const median = lpa.length % 2 ? lpa[(lpa.length - 1) / 2] : (lpa[lpa.length / 2 - 1] + lpa[lpa.length / 2]) / 2;
  const chg = base.lines.map((l) => l.chg);
  const workingDays = days.length;
  const targetMonth = TARGET_SALES_PER_AGENT_DAY * agents.length * workingDays;
  const quoteRowNos = rowsWhere((r) => r.callStatus === CALL_STATUS.quote);
  const callbackRowNos = rowsWhere((r) => r.callStatus === CALL_STATUS.callback);
  const trailing = rowsWhere((r) => r.callStatus !== r.callStatus.trimEnd());
  const distinctStatuses = [...new Set(wsRows.map((r) => r.callStatus).filter(Boolean))].sort();
  const matchedRows = wsRows.filter((r) => r.inBase);
  const driftAccounts = matchedRows.filter((r) => r.oocShown !== r.oocBase).map((r) => r.accountNo);
  const doneDead = wsRows.filter((r) => r.commentStatus === "DONE" && DEAD.has(cleanStatus(r.callStatus))).length;
  const zeroRows = irows.map((r, i) => (r.bookedOff ? i + 2 : -1)).filter((n) => n > 0);
  const dayStatusRows = irows.map((r, i) => (r.dayStatus ? i + 2 : -1)).filter((n) => n > 0);
  const contactNumberCells = wsRows.filter((r) => typeof r.contact === "number").length;
  const landlineRows = rowsWhere((r) => r.contactKind === "bracket_landline" || r.contactKind === "stripped_landline");

  type DefectIn = {
    id: string;
    kind: "structural" | "count";
    sheet: string | null;
    count: number | null;
    summary: string;
    columns?: string[];
    details?: Record<string, unknown>;
    rows?: number[];
    accounts?: number[];
  };
  const d = (e: DefectIn): DefectEntry => ({ ...e, columns: e.columns ?? [], details: e.details ?? {} });

  const defects: Record<string, DefectEntry> = {
    D01: d({
      id: "D01", kind: "structural", sheet: SHEET.base, columns: ["Account No", "Msisdn"], count: null,
      summary: `'${SHEET.base}' has one row per line (Msisdn): ${base.lines.length} lines across ${linesByAccount.size} Account No values; there is no company registration number or customer ID column beyond Account No.`,
      details: { lines: base.lines.length, accounts: linesByAccount.size, lines_per_account_median: median, lines_per_account_max: lpa[lpa.length - 1] },
    }),
    D02: d({
      id: "D02", kind: "structural", sheet: SHEET.base, count: N,
      summary: `No phone, email or WhatsApp column in '${SHEET.base}'. Contact details exist only in '${SHEET.worksheet}' for ${N} accounts (${pct(N, linesByAccount.size)}% of ${linesByAccount.size} accounts).`,
      details: { worksheet_accounts: N, base_accounts: linesByAccount.size, pct_of_accounts: pct(N, linesByAccount.size) },
    }),
    D03: d({
      id: "D03", kind: "count", sheet: SHEET.base, columns: ["Customer Name", "Account No"], count: base.duplicatePairs.length,
      summary: `${base.duplicatePairs.length} companies appear under two Account Nos: ${base.duplicatePairs.filter((p) => p.kind === "exact").length} with the exact same name and ${base.duplicatePairs.filter((p) => p.kind === "variant").length} more after normalising spacing / "(PTY) LTD" / "CC".`,
      details: { pairs: base.duplicatePairs.map((p) => ({ kind: p.kind, account_a: p.accountA, name_a: p.nameA, account_b: p.accountB, name_b: p.nameB })) },
      accounts: base.duplicatePairs.flatMap((p) => [p.accountA, p.accountB]),
    }),
    D04: d({
      id: "D04", kind: "count", sheet: SHEET.worksheet, columns: ["Account No"], count: absent.length,
      summary: `${absent.length} worksheet Account Nos are not in '${SHEET.base}'.`,
      accounts: absent.map((a) => a.accountNo), rows: rowsWhere((r) => !r.inBase),
    }),
    D05: d({
      id: "D05", kind: "count", sheet: SHEET.worksheet, columns: ["Contact"], count: N - wsRows.filter((r) => r.contactKind === "bracket_mobile").length,
      summary: `'Contact' is not E.164: ${wsRows.filter((r) => r.contactKind.startsWith("bracket")).length} rows in "(0xx) xxxxxxx" style (${pct(wsRows.filter((r) => r.contactKind.startsWith("bracket")).length, N)}%), ${wsRows.filter((r) => r.contactKind.startsWith("stripped")).length} stored as numbers with the leading 0 lost (${pct(wsRows.filter((r) => r.contactKind.startsWith("stripped")).length, N)}%), ${wsRows.filter((r) => r.contactKind === "zero").length} are a 0 placeholder (${pct(wsRows.filter((r) => r.contactKind === "zero").length, N)}%), ${landlineRows.length} are landlines, ${wsRows.filter((r) => r.contactKind === "other_string").length} in other formats.`,
      details: {
        bracket_style: wsRows.filter((r) => r.contactKind.startsWith("bracket")).length,
        stripped_integer: wsRows.filter((r) => r.contactKind.startsWith("stripped")).length,
        zero_placeholder: wsRows.filter((r) => r.contactKind === "zero").length,
        landline: landlineRows.length,
        other_format: wsRows.filter((r) => r.contactKind === "other_string").length,
        usable_mobile: wsRows.filter(usableMobile).length,
        zero_rows: rowsWhere((r) => r.contactKind === "zero"),
        stripped_rows: rowsWhere((r) => r.contactKind.startsWith("stripped")),
        landline_rows: landlineRows,
      },
      rows: rowsWhere((r) => r.contactKind !== "bracket_mobile"),
    }),
    D06: d({
      id: "D06", kind: "count", sheet: SHEET.worksheet, columns: ["Account Holder Name", "Email"], count: holderZero.size,
      summary: `'Account Holder Name' is 0 in ${holderZero.size} of ${N} worksheet rows (${pct(holderZero.size, N)}%); 'Email' is blank in ${emailBlank.size} rows (${pct(emailBlank.size, N)}%).`,
      details: { holder_zero: holderZero.size, email_blank: emailBlank.size, rows_total: N, email_blank_rows: rowsWhere((r) => r.email === null) },
      rows: rowsWhere((r) => r.holder === 0),
    }),
    D07: d({
      id: "D07", kind: "count", sheet: SHEET.worksheet, columns: ["Contact"], count: contactNumberCells,
      summary: `'Contact' mixes cell types: ${contactNumberCells} numeric cells and ${N - contactNumberCells} text cells.`,
      details: { number_cells: contactNumberCells, string_cells: N - contactNumberCells },
      rows: rowsWhere((r) => typeof r.contact === "number"),
    }),
    D08: d({
      id: "D08", kind: "count", sheet: SHEET.worksheet, columns: ["date contacted", "Date digits (helper)", "Date (clean)"], count: nStrings,
      summary: `'date contacted' holds ${nStrings} text dates in mixed formats (${nUs} US m/d/yyyy, ${nPadded} ambiguous like 08/09/2026, ${nYdm} YYYY/DD/MM, ${nImpossible} impossible such as a month of 13+), ${nDates} real Excel dates and ${N - nStrings - nDates} blanks; the helper column holds digit strings like ${wsRows.find((r) => r.dateKind === "impossible")?.dateDigits ?? ""}.`,
      details: {
        text_dates: nStrings, us_style: nUs, padded_ambiguous: nPadded, yyyy_dd_mm: nYdm, impossible: nImpossible, excel_dates: nDates, blanks: N - nStrings - nDates,
        impossible_rows: rowsWhere((r) => r.dateKind === "impossible"),
        ambiguous_rows: rowsWhere((r) => r.dateKind === "padded_ambiguous"),
        excel_date_rows: rowsWhere((r) => r.dateKind === "excel_date"),
        blank_rows: rowsWhere((r) => r.dateKind === "blank"),
        clean_errors: wsRows.filter((r) => r.dateClean !== null && !(r.dateClean instanceof Date)).length,
      },
      rows: rowsWhere((r) => r.dateKind !== "excel_date" && r.dateKind !== "blank"),
    }),
    D09: d({
      id: "D09", kind: "count", sheet: SHEET.worksheet, columns: ["Completed Allocated Blocks? (4/4)"], count: wsRows.filter((r) => r.blocksKind === "date").length,
      summary: `'Completed Allocated Blocks? (4/4)' was auto-converted to dates in ${wsRows.filter((r) => r.blocksKind === "date").length} rows (3/4 became 2026-03-04); ${wsRows.filter((r) => r.blocksKind === "text_zero").length} rows still read "0/4".`,
      details: { date_cells: wsRows.filter((r) => r.blocksKind === "date").length, text_zero: wsRows.filter((r) => r.blocksKind === "text_zero").length, blank: wsRows.filter((r) => r.blocksKind === "blank").length },
      rows: rowsWhere((r) => r.blocksKind === "date"),
    }),
    D10: d({
      id: "D10", kind: "count", sheet: SHEET.base, columns: ["Contract End Date", "Contract Term"], count: epoch.length,
      summary: `${epoch.length} lines have 'Contract End Date' 1970-01-01 with 'Contract Term' 0.`,
      rows: epoch.map(baseRowOf),
    }),
    D11: d({
      id: "D11", kind: "count", sheet: SHEET.base, columns: ["Contract Status", "Contract End Date"], count: stale.length,
      summary: `${stale.length} lines are 'InContract' although their 'Contract End Date' is before the export date ${iso(exportDate)}.`,
      rows: stale.map(baseRowOf),
    }),
    D12: d({
      id: "D12", kind: "count", sheet: SHEET.base, columns: ["Month Remaining In Contract"], count: unknownBucket.length,
      summary: `'Month Remaining In Contract' is a text bucket (${[...new Set(base.lines.map((l) => l.monthsBucket))].sort().join(", ")}); ${unknownBucket.length} lines read "Unknown".`,
      details: { buckets: Object.fromEntries([...new Set(base.lines.map((l) => l.monthsBucket))].sort().map((b) => [b, base.lines.filter((l) => l.monthsBucket === b).length])) },
      rows: unknownBucket.map(baseRowOf),
    }),
    D13: d({
      id: "D13", kind: "count", sheet: SHEET.worksheet, columns: ["Call Status", "Status (clean)"], count: distinctStatuses.length,
      summary: `'Call Status' is free text with ${distinctStatuses.length} distinct values (${trailing.length} rows with a trailing space, e.g. "Voicemail / Email sent " vs "Voicemail, email sent"); column F has no header but holds the notes; 'Status (clean)' was bolted on afterwards.`,
      details: { distinct_values: distinctStatuses, trailing_space_rows: trailing.length, headerless_column: "F", clean_blank_but_status_set: skippedClean.size },
      rows: trailing,
    }),
    D14: d({
      id: "D14", kind: "count", sheet: SHEET.worksheet, columns: ["Next Action", "Action Required", "Call Status"], count: callbackRowNos.length,
      summary: `'Next Action' and 'Action Required' are empty in all ${N} rows; ${callbackRowNos.length} rows are "${CALL_STATUS.callback}" with no callback date anywhere.`,
      details: { next_action_empty: N, action_required_empty: N, callbacks_without_date: callbackRowNos.length },
      rows: callbackRowNos,
    }),
    D15: d({
      id: "D15", kind: "count", sheet: SHEET.worksheet, columns: ["Call Status", "Application Status"], count: quoteRowNos.length,
      summary: `${quoteRowNos.length} rows are "${CALL_STATUS.quote}" but 'Application Status' has only 1 "Processing" and 1 "Approved"; it is blank in ${N - 2} of ${N} rows, with no link to a quote or ticket.`,
      details: { quote_rows: quoteRowNos.length, processing: 1, approved: 1, application_status_blank: N - 2, quotes_without_next_step: quoteRowNos.length - 2 },
      rows: quoteRowNos,
    }),
    D16: d({
      id: "D16", kind: "count", sheet: SHEET.worksheet, columns: ["Comment Status"], count: doneRows.size,
      summary: `'Comment Status' is "DONE" on ${doneRows.size} of ${N} rows (${pct(doneRows.size, N)}%), including ${doneDead} dead or unanswered calls.`,
      details: { done: doneRows.size, done_on_dead_calls: doneDead },
    }),
    D17: d({
      id: "D17", kind: "count", sheet: SHEET.worksheet, columns: ["Out Of Contract"], count: driftAccounts.length,
      summary: `The worksheet's 'Out Of Contract' count disagrees with '${SHEET.base}' for ${driftAccounts.length} of ${matchedRows.length} matched accounts (${pct(driftAccounts.length, matchedRows.length)}%).`,
      details: { matched_accounts: matchedRows.length, mismatched: driftAccounts.length },
      accounts: driftAccounts,
    }),
    D18: d({
      id: "D18", kind: "structural", sheet: SHEET.base, columns: ["Telemetry", "Region", "Channel", "RSM", "AM"], count: null,
      summary: `Constant columns: Telemetry=N, Region=NAT, Channel=VSAM, one RSM and one AM in '${SHEET.base}'; Reason and QTY constant in '${SHEET.worksheet}'. The AM is spelt "${amMisspelt}" in the base but "${am.full}" in '${SHEET.dialler}'.`,
      details: { constant_base_columns: ["Telemetry", "Region", "Channel", "RSM", "AM"], constant_worksheet_columns: ["Reason", "QTY", "Consultant"], am_base: amMisspelt, am_dialler: am.full },
    }),
    D19: d({
      id: "D19", kind: "structural", sheet: SHEET.dialler, columns: [...DIALLER_COLUMNS], count: diallerUsers.length,
      summary: `'${SHEET.dialler}' has ${diallerUsers.length} rows of per-agent monthly totals only: no per-call rows, no Msisdn, no timestamps, so calls cannot be linked to customers or outcomes.`,
    }),
    D20: d({
      id: "D20", kind: "structural", sheet: null, columns: ["Agent", "Agent ", "Consultant"], count: diallerUsers.length,
      summary: `Agent identity is not reconciled: ${diallerUsers.length} dialler users (including "test 23" and "Dialler Support"), ${agents.length} agents in '${SHEET.interval}', 1 consultant in '${SHEET.worksheet}'; the same person appears as "${diallerAgent(consultant)}", "${intervalAgent(consultant)}" and "${consultant.full}".`,
      details: {
        dialler_users: diallerUsers.length,
        interval_agents: agents.length,
        worksheet_consultants: 1,
        test_or_system_users: ["test 23", "Dialler Support"],
        mapping: agents.map((a) => ({ worksheet: a === consultant ? a.full : null, interval: intervalAgent(a), dialler: diallerAgent(a) })),
      },
    }),
    D21: d({
      id: "D21", kind: "count", sheet: SHEET.interval, columns: [...INTERVAL_COLUMNS], count: zeroRows.length,
      summary: `'${SHEET.interval}': ${INTERVAL_COLUMNS.filter((h) => h !== h.trimEnd()).length} headers have trailing spaces, the target is packed into one string "${TARGET_STRING}", ${zeroRows.length} booked-off agent-days are recorded as 0 calls, and 'Day Status' is filled in only ${dayStatusRows.length} of ${irows.length} rows.`,
      details: { trailing_space_headers: INTERVAL_COLUMNS.filter((h) => h !== h.trimEnd()), target_string: TARGET_STRING, zero_rows: zeroRows.length, day_status_filled: dayStatusRows.length, rows_total: irows.length },
      rows: zeroRows,
    }),
    D22: d({
      id: "D22", kind: "count", sheet: SHEET.interval, columns: ["Calls ", "Connected", "Opportunities ", "Sales"], count: funnel.sales,
      summary: `September funnel, ${agents.length} agents: ${funnel.calls} calls → ${funnel.connected} connected (${pct(funnel.connected, funnel.calls)}%) → ${funnel.opps} opportunities (${pct(funnel.opps, funnel.connected)}% of connected) → ${funnel.sales} sales, against a target of ${targetMonth} (${pct(funnel.sales, targetMonth)}%). The collapse is connected → opportunity.`,
      details: { calls: funnel.calls, connected: funnel.connected, opportunities: funnel.opps, sales: funnel.sales, target_month: targetMonth },
    }),
    D23: d({
      id: "D23", kind: "structural", sheet: SHEET.base, columns: [...BASE_COLUMNS], count: null,
      summary: `No consent, opt-out or do-not-contact column in any sheet; '${SHEET.base}' holds Msisdn, device and spend per line (personal data).`,
    }),
  };
  for (const code of D_CODES) if (!defects[code]) throw new Error(`bundle A: ${code} missing from the answer key`);

  const figures: Record<string, number | string> = {
    export_date: iso(exportDate),
    base_lines: base.lines.length,
    base_accounts: linesByAccount.size,
    lines_per_account_median: median,
    lines_per_account_max: lpa[lpa.length - 1],
    out_of_contract_lines: ooc.length,
    out_of_contract_pct: pct(ooc.length, base.lines.length),
    worksheet_accounts: N,
    worksheet_account_pct: pct(N, linesByAccount.size),
    holder_zero: holderZero.size,
    email_blank: emailBlank.size,
    contact_zero: wsRows.filter((r) => r.contactKind === "zero").length,
    dup_pairs: base.duplicatePairs.length,
    window_days: WINDOW_DAYS,
    window_lines: windowLines.length,
    window_accounts: windowAccounts.size,
    window_line_pct: pct(windowLines.length, base.lines.length),
    window_charges_zar: windowCharges,
    window_accounts_in_worksheet: windowInWs.length,
    window_accounts_in_worksheet_pct: pct(windowInWs.length, windowAccounts.size),
    window_accounts_with_contact: windowWithContact.length,
    window_contactable_pct: pct(windowWithContact.length, windowAccounts.size),
    window_no_contact_pct: pct(windowAccounts.size - windowWithContact.length, windowAccounts.size),
    window_accounts_with_mobile: windowWithMobile.length,
    incontract_expired: stale.length,
    epoch_lines: epoch.length,
    chg_zero: chg.filter((c) => c === 0).length,
    chg_blank: chg.filter((c) => c === null).length,
    funnel_calls: funnel.calls,
    funnel_connected: funnel.connected,
    funnel_connect_rate_pct: pct(funnel.connected, funnel.calls),
    funnel_opportunities: funnel.opps,
    funnel_opp_rate_pct: pct(funnel.opps, funnel.connected),
    funnel_sales: funnel.sales,
    target_sales_month: targetMonth,
    sales_pct_of_target: pct(funnel.sales, targetMonth),
    quote_rows: quoteRowNos.length,
    quotes_without_next_step: quoteRowNos.length - 2,
    callbacks_no_date: callbackRowNos.length,
    working_days: workingDays,
    agents: agents.length,
    // Phase 2 utility-template cost (doc 13): window accounts × 2 messages × ~R0.12.
    phase2_utility_cost_zar: Math.round(windowAccounts.size * 2 * 0.12),
  };

  const answerKey: BundleAAnswerKey = {
    bundle: "bundle_a",
    version,
    seed,
    export_date: iso(exportDate),
    file: BUNDLE_A_FILE,
    sheets: {
      base: { name: SHEET.base, rows: baseRows.length, columns: [...BASE_COLUMNS] },
      worksheet: { name: SHEET.worksheet, rows: wsRows.length, columns: [...WORKSHEET_COLUMNS] },
      dialler: { name: SHEET.dialler, rows: diallerRows.length, columns: [...DIALLER_COLUMNS] },
      interval: { name: SHEET.interval, rows: intervalRows.length, columns: [...INTERVAL_COLUMNS] },
    },
    figures,
    defects,
  };

  return { workbook: wb, answerKey, base, people: { agents, am, rsm, consultant }, worksheetRows: wsRows };
}

export type { WsRow };
