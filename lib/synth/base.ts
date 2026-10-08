import { addDays, parseIso, utc } from "./dates";
import { makeCompanies, makeMobile, nameVariant, type Company } from "./names";
import type { SynthRng } from "./rng";

/**
 * The line-grain customer base shared by bundles A, B and C (docs/11 "vsam base raw").
 * Distributions mirror the real extract's proportions; every value is generated.
 */

export interface PricePlan {
  code: string;
  name: string;
  category: "Voice" | "Data" | "Hybrid" | "M2M";
  packageCode: string;
  packageName: string;
  tariffCode: string;
  tariffName: string;
  /** H07: these plans may only upgrade in the last month before contract end. */
  lastMonthOnly: boolean;
}

export const PRICE_PLANS: readonly PricePlan[] = [
  { code: "BZT100", name: "Biz Talk 100", category: "Voice", packageCode: "PK110", packageName: "Business Voice S", tariffCode: "TF21", tariffName: "Biz Talk Standard", lastMonthOnly: false },
  { code: "BZT250", name: "Biz Talk 250", category: "Voice", packageCode: "PK120", packageName: "Business Voice M", tariffCode: "TF22", tariffName: "Biz Talk Standard", lastMonthOnly: false },
  { code: "BZT600", name: "Biz Talk 600", category: "Voice", packageCode: "PK130", packageName: "Business Voice L", tariffCode: "TF23", tariffName: "Biz Talk Plus", lastMonthOnly: false },
  { code: "BZS2G", name: "Biz Smart 2GB", category: "Hybrid", packageCode: "PK210", packageName: "Business Smart S", tariffCode: "TF31", tariffName: "Biz Smart Hybrid", lastMonthOnly: false },
  { code: "BZS6G", name: "Biz Smart 6GB", category: "Hybrid", packageCode: "PK220", packageName: "Business Smart M", tariffCode: "TF32", tariffName: "Biz Smart Hybrid", lastMonthOnly: false },
  { code: "BZS15G", name: "Biz Smart 15GB", category: "Hybrid", packageCode: "PK230", packageName: "Business Smart L", tariffCode: "TF33", tariffName: "Biz Smart Hybrid Plus", lastMonthOnly: false },
  { code: "BZD10G", name: "Biz Data 10GB", category: "Data", packageCode: "PK310", packageName: "Business Data M", tariffCode: "TF41", tariffName: "Biz Data", lastMonthOnly: false },
  { code: "BZD50G", name: "Biz Data 50GB", category: "Data", packageCode: "PK320", packageName: "Business Data L", tariffCode: "TF42", tariffName: "Biz Data", lastMonthOnly: false },
  { code: "BZDUNC", name: "Biz Data Uncapped", category: "Data", packageCode: "PK330", packageName: "Business Data XL", tariffCode: "TF43", tariffName: "Biz Data Uncapped", lastMonthOnly: false },
  { code: "BZF150", name: "Biz Flexi Top-Up 150", category: "Voice", packageCode: "PK140", packageName: "Business Flexi", tariffCode: "TF24", tariffName: "Biz Flexi", lastMonthOnly: true },
  { code: "FLT50M", name: "Fleet Track M2M 50MB", category: "M2M", packageCode: "PK410", packageName: "Fleet M2M", tariffCode: "TF51", tariffName: "M2M Telemetry", lastMonthOnly: true },
  { code: "BZT1K", name: "Biz Talk Unlimited", category: "Voice", packageCode: "PK150", packageName: "Business Voice XL", tariffCode: "TF25", tariffName: "Biz Talk Premium", lastMonthOnly: false },
];

const DEVICES = {
  Smartphone: [["Kestrel", ["K5", "K7 Pro", "K9 Max"]], ["Zanzi", ["Z12", "Z12 Pro", "Z20 Ultra"]], ["Nova", ["Nova A3", "Nova A5"]]],
  Router: [["Baobab Tech", ["B-Router 4G", "B-Router 5G Home"]], ["Umoya Devices", ["UM LTE Hub"]]],
  Tablet: [["Zanzi", ["Z-Tab 10"]], ["Kestrel", ["K-Pad 8"]]],
  "Feature Phone": [["Nova", ["Nova F1"]], ["Kudu Mobile", ["Kudu 3310i"]]],
} as const satisfies Record<string, readonly (readonly [string, readonly string[]])[]>;

export type DeviceType = keyof typeof DEVICES;
export interface Device {
  type: DeviceType;
  manufacturer: string;
  model: string;
}

export type Segment = "SME" | "LE" | "PE";

export interface Customer {
  id: number;
  company: Company;
  regNo: string;
  segment: Segment;
}

export interface Account {
  accountNo: number;
  customerId: number;
  /** Name as written on this account (may be a variant of the customer's name). */
  displayName: string;
  dealerCode: string;
  /** Reg No shown in exports that carry one (null = blank cell). */
  regNoShown: string | null;
}

export type LineKind = "ooc" | "window" | "future" | "stale" | "epoch";

export interface Line {
  /** Stable line id within the bundle (0-based, export order). */
  idx: number;
  accountNo: number;
  /** National format, 10 digits (0821234567). */
  mobile: string;
  term: number;
  /** null never; epoch placeholders are 1970-01-01. */
  endDate: Date;
  status: "InContract" | "Out Of Contract";
  monthsBucket: string;
  plan: PricePlan;
  device: Device | null;
  /** Monthly charge in rands; null = blank cell. */
  chg: number | null;
  bam: "Y" | "N";
  kind: LineKind;
}

export interface DuplicatePair {
  kind: "exact" | "variant";
  customerId: number;
  accountA: number;
  accountB: number;
  nameA: string;
  nameB: string;
}

export interface BaseOptions {
  accounts: number;
  /** Total line count must land in this range. */
  lineRange: [number, number];
  maxLinesPerAccount: number;
  exactDuplicatePairs: number;
  variantDuplicatePairs: number;
  staleInContract: number;
  epochLines: number;
  windowShare: number;
  oocShare: number;
  exportDate: string;
  regNoShare: number;
}

export interface Base {
  customers: Customer[];
  accounts: Account[];
  lines: Line[];
  duplicatePairs: DuplicatePair[];
  exportDate: Date;
}

export const EPOCH = utc(1970, 1, 1);

/** "(YYYY)/NNNNNN/07" style fictional company registration number. */
export function makeRegNo(rng: SynthRng, suffix: string, taken: Set<string>): string {
  for (;;) {
    const r = `${rng.int(1998, 2023)}/${String(rng.int(100000, 999999))}/${suffix}`;
    if (taken.has(r)) continue;
    taken.add(r);
    return r;
  }
}

function segment(rng: SynthRng): Segment {
  return rng.weighted([
    ["SME", 980],
    ["LE", 15],
    ["PE", 5],
  ] as const);
}

function linesPerAccount(rng: SynthRng, n: number, opts: BaseOptions): number[] {
  // Heavy tail: log-normal around a median of 2.
  const counts = Array.from({ length: n }, () => Math.min(opts.maxLinesPerAccount - 4, Math.max(1, Math.round(2 * Math.exp(1.05 * rng.normal())))));
  // One very large account near the maximum.
  counts[rng.int(0, n - 1)] = rng.int(opts.maxLinesPerAccount - 4, opts.maxLinesPerAccount);
  let total = counts.reduce((s, c) => s + c, 0);
  const target = rng.int(opts.lineRange[0], opts.lineRange[1]);
  let guard = 0;
  while (total !== target && guard++ < 200_000) {
    const i = rng.int(0, n - 1);
    if (total < target && counts[i] >= 2 && counts[i] < opts.maxLinesPerAccount - 4) {
      counts[i]++;
      total++;
    } else if (total > target && counts[i] > 2 && counts[i] < opts.maxLinesPerAccount - 4) {
      counts[i]--;
      total--;
    }
  }
  return counts;
}

function term(rng: SynthRng): number {
  return rng.weighted([
    [24, 630],
    [36, 330],
    [12, 18],
    [18, 9],
    [6, 6],
    [3, 4],
    [1, 3],
  ] as const);
}

export function monthsBucket(endDate: Date, asOf: Date): string {
  const days = (endDate.getTime() - asOf.getTime()) / 86_400_000;
  if (days < 0) return "Out Of Contract";
  const months = days / 30.44;
  if (months <= 3) return "0-3 Months";
  if (months <= 6) return "4-6 Months";
  if (months <= 12) return "7-12 Months";
  if (months <= 24) return "13-24 Months";
  return "25-36 Months";
}

function charge(rng: SynthRng): number | null {
  const r = rng.next();
  if (r < 0.006) return null;
  if (r < 0.066) return 0;
  for (;;) {
    const v = 310 * Math.exp(0.85 * rng.normal());
    if (v >= 29 && v <= 2650) return Math.round(v * 100) / 100;
  }
}

function device(rng: SynthRng, plan: PricePlan): Device | null {
  if (rng.chance(0.37)) return null;
  const type: DeviceType =
    plan.category === "Data"
      ? rng.weighted([["Router", 60], ["Tablet", 25], ["Smartphone", 15]] as const)
      : plan.category === "M2M"
        ? "Router"
        : rng.weighted([["Smartphone", 85], ["Feature Phone", 10], ["Tablet", 5]] as const);
  const options: readonly (readonly [string, readonly string[]])[] = DEVICES[type];
  const [manufacturer, models] = rng.pick(options);
  return { type, manufacturer, model: rng.pick(models) };
}

export function generateBase(rng: SynthRng, opts: BaseOptions): Base {
  const exportDate = parseIso(opts.exportDate);
  const nDup = opts.exactDuplicatePairs + opts.variantDuplicatePairs;
  const nCustomers = opts.accounts - nDup;
  const companies = makeCompanies(rng.fork("companies"), nCustomers);
  const regTaken = new Set<string>();
  const customers: Customer[] = companies.map((company, i) => ({
    id: i + 1,
    company,
    regNo: makeRegNo(rng, company.legalSuffix === "CC" ? "23" : "07", regTaken),
    segment: segment(rng),
  }));

  // Account numbers, unique 8-digit.
  const acctTaken = new Set<number>();
  const newAccountNo = () => {
    for (;;) {
      const n = rng.int(30_000_000, 89_999_999);
      if (!acctTaken.has(n)) {
        acctTaken.add(n);
        return n;
      }
    }
  };
  const dealer = () => (rng.chance(0.95) ? "KC-VS01" : "KC-VS02");
  const regShown = (c: Customer) => (rng.chance(opts.regNoShare) ? c.regNo : null);

  const accounts: Account[] = customers.map((c) => ({
    accountNo: newAccountNo(),
    customerId: c.id,
    displayName: c.company.name,
    dealerCode: dealer(),
    regNoShown: regShown(c),
  }));

  // D03: the same company under a second account (exact name, then spacing/suffix variants).
  const dupCustomers = rng.sample(customers, nDup);
  const duplicatePairs: DuplicatePair[] = dupCustomers.map((c, i) => {
    const kind = i < opts.exactDuplicatePairs ? "exact" : "variant";
    const first = accounts.find((a) => a.customerId === c.id)!;
    let nameB = c.company.name;
    if (kind === "variant") {
      for (let g = 0; g < 20 && nameB === c.company.name; g++) nameB = nameVariant(rng, c.company);
    }
    const second: Account = { accountNo: newAccountNo(), customerId: c.id, displayName: nameB, dealerCode: dealer(), regNoShown: regShown(c) };
    accounts.push(second);
    return { kind, customerId: c.id, accountA: first.accountNo, accountB: second.accountNo, nameA: first.displayName, nameB };
  });

  const ordered = rng.shuffle(accounts);
  const counts = linesPerAccount(rng, ordered.length, opts);
  const mobiles = new Set<string>();
  const lines: Line[] = [];
  ordered.forEach((a, ai) => {
    const plan0 = rng.pick(PRICE_PLANS);
    for (let k = 0; k < counts[ai]; k++) {
      const plan = rng.chance(0.7) ? plan0 : rng.pick(PRICE_PLANS);
      const t = term(rng);
      lines.push({
        idx: lines.length,
        accountNo: a.accountNo,
        mobile: makeMobile(rng, mobiles),
        term: t,
        endDate: exportDate,
        status: "InContract",
        monthsBucket: "",
        plan,
        device: device(rng, plan),
        chg: charge(rng),
        bam: plan.category === "Data" || rng.chance(0.06) ? "Y" : "N",
        kind: "future",
      });
    }
  });

  // Contract dates and status. The planted defects get exact counts; everything else clusters
  // by account (lines on one account mostly share a contract cycle), at the requested shares.
  const idxs = rng.shuffle(lines.map((l) => l.idx));
  const epoch = idxs.slice(0, opts.epochLines);
  const stale = idxs.slice(opts.epochLines, opts.epochLines + opts.staleInContract);
  const special = new Set([...epoch, ...stale]);

  for (const i of epoch) {
    Object.assign(lines[i], { kind: "epoch", term: 0, endDate: EPOCH, status: "Out Of Contract", monthsBucket: "Unknown" });
  }
  for (const i of stale) {
    // InContract on the day the report ran; the end date has since passed (H09).
    const end = addDays(exportDate, -rng.int(1, 120));
    Object.assign(lines[i], { kind: "stale", endDate: end, status: "InContract", monthsBucket: "0-3 Months" });
  }

  type Kind = "ooc" | "window" | "future";
  const shares: readonly (readonly [Kind, number])[] = [
    ["ooc", opts.oocShare],
    ["window", opts.windowShare],
    ["future", 1 - opts.oocShare - opts.windowShare],
  ];
  const maxFutureDays = (term: number) => Math.round(term * 30.4) - 1;
  const endFor = (k: Kind, term: number): Date =>
    k === "ooc"
      ? addDays(exportDate, -rng.int(1, 1100))
      : k === "window"
        ? addDays(exportDate, rng.int(0, 90))
        : addDays(exportDate, rng.int(91, Math.max(92, maxFutureDays(term))));
  const byAccount = new Map<number, Line[]>();
  for (const l of lines) if (!special.has(l.idx)) byAccount.set(l.accountNo, [...(byAccount.get(l.accountNo) ?? []), l]);
  for (const ls of byAccount.values()) {
    const primary = rng.weighted(shares);
    const primaryEnd = endFor(primary, ls[0].term);
    for (const l of ls) {
      // Large fleets are on many contracts; small accounts mostly follow one cycle.
      const follow = ls.length <= 12 && rng.chance(0.8);
      const kind = follow ? primary : rng.weighted(shares);
      // A contract shorter than 3 months cannot end more than 90 days out.
      if (kind === "future" && maxFutureDays(l.term) < 92) l.term = 12;
      const fits = kind !== "future" || primaryEnd.getTime() - exportDate.getTime() <= maxFutureDays(l.term) * 86_400_000;
      const end = follow && fits && rng.chance(0.7) ? primaryEnd : endFor(kind, l.term);
      if (kind === "ooc") Object.assign(l, { kind, endDate: end, status: "Out Of Contract", monthsBucket: "Out Of Contract" });
      else Object.assign(l, { kind, endDate: end, status: "InContract", monthsBucket: monthsBucket(end, exportDate) });
    }
  }
  const future = lines.filter((l) => l.kind === "future").map((l) => l.idx);
  // A little "Unknown" noise in the bucket column beyond the epoch rows (D12).
  for (const i of rng.sample(future, Math.round(lines.length * 0.012))) lines[i].monthsBucket = "Unknown";

  // The maximum monthly charge sits near R2,700.
  const priced = lines.filter((l) => l.chg !== null && l.chg > 0);
  rng.pick(priced).chg = rng.int(2655, 2699) + rng.int(0, 99) / 100;

  return { customers, accounts, lines, duplicatePairs, exportDate };
}
