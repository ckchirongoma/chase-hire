import { z } from "zod";
import { normaliseCompanyName } from "@/lib/synth/names";

/**
 * The parts of bundle C's INTERNAL expected_month2.json (lib/synth/bundle-c.ts) the harness
 * reads: month-2 deltas for M1–M7, the sentinel customers for M2, and the opt-out matches for
 * U7. Unknown fields pass through, so a newer generator does not break an older harness.
 */
export const HarnessExpected = z
  .object({
    bundle: z.literal("bundle_c"),
    version: z.string(),
    month1: z.object({ customers: z.number(), lines: z.number() }).passthrough(),
    month2: z
      .object({
        new_customers: z.number().int().nonnegative(),
        lines_new: z.number().int().nonnegative(),
        lines_removed: z.number().int().nonnegative(),
        lines_changed: z.number().int().nonnegative(),
        changed: z.array(z.object({ msisdn_e164: z.string(), field: z.string(), from: z.string(), to: z.string() })).default([]),
        removed_msisdns: z.array(z.string()).default([]),
        new_msisdns: z.array(z.string()).default([]),
        quarantine_expected: z.array(z.object({ row: z.number().int(), reason: z.string() })).default([]),
      })
      .passthrough(),
    drift: z.object({ renamed: z.object({ from: z.string(), to: z.string() }), added: z.array(z.string()).default([]) }).passthrough(),
    sentinels: z.array(
      z
        .object({
          reg_no: z.string().nullable(),
          name: z.string(),
          account_nos: z.array(z.number()).default([]),
          msisdns: z.array(z.string()).default([]),
        })
        .passthrough(),
    ),
    optouts: z
      .object({
        matches: z.array(z.object({ listed_name: z.string(), status: z.string(), customer_reg_no: z.string().nullable(), account_nos: z.array(z.number()).default([]) }).passthrough()).default([]),
      })
      .passthrough()
      .default({ matches: [] }),
  })
  .passthrough();
export type HarnessExpected = z.output<typeof HarnessExpected>;

export const BUNDLE_FILES = {
  expected: "internal/expected_month2.json",
  month2: "internal/base_month2.xlsx",
  drift: "internal/base_month2_drift.xlsx",
  /** The list the candidate got (company names only): what U7 matches against. */
  optouts: "candidate/optouts_legal.xlsx",
} as const;

export interface OptoutEntry {
  listedName: string;
  normalised: string;
  status: string;
  regNo: string | null;
  accountNos: number[];
}

/** Opt-out list entries (the candidate file's company names, plus the ground-truth reg no). */
export function optoutEntries(expected: HarnessExpected | null): OptoutEntry[] {
  return (expected?.optouts.matches ?? []).map((m) => ({
    listedName: m.listed_name,
    normalised: normaliseCompanyName(m.listed_name),
    status: m.status,
    regNo: m.customer_reg_no,
    accountNos: m.account_nos,
  }));
}

/**
 * Opt-out entries from the candidate's optouts_legal.xlsx (first sheet, a "Company" column and
 * optionally "Status"), with the registration number from the answer key when the listed name
 * is one it knows. Null when the sheet has no company column.
 */
export function optoutEntriesFromSheet(rows: string[][], expected: HarnessExpected | null): OptoutEntry[] | null {
  const headerAt = rows.findIndex((r) => r.some((c) => /^\s*(company|company name|customer|customer name|name)\s*$/i.test(c)));
  if (headerAt < 0) return null;
  const header = rows[headerAt].map((c) => c.trim().toLowerCase());
  const nameCol = header.findIndex((c) => /^(company|company name|customer|customer name|name)$/.test(c));
  const statusCol = header.findIndex((c) => /status/.test(c));
  const known = new Map((expected?.optouts.matches ?? []).map((m) => [m.listed_name.trim(), m]));
  const out: OptoutEntry[] = [];
  for (const r of rows.slice(headerAt + 1)) {
    const listedName = (r[nameCol] ?? "").trim();
    if (!listedName) continue;
    const k = known.get(listedName);
    out.push({
      listedName,
      normalised: normaliseCompanyName(listedName),
      status: (statusCol >= 0 ? r[statusCol]?.trim() : "") || k?.status || "Opted out",
      regNo: k?.customer_reg_no ?? null,
      accountNos: k?.account_nos ?? [],
    });
  }
  return out;
}

export interface CustomerLite {
  id: string;
  reg_no?: string | null;
  legal_name?: string | null;
  normalised_name?: string | null;
}

/**
 * Customers (as the app stores them) that are on the opt-out list: by registration number when
 * both sides have one, else by normalised company name. "Opted out" entries come first.
 */
export function matchOptouts(customers: CustomerLite[], entries: OptoutEntry[]): { customer: CustomerLite; entry: OptoutEntry; via: "reg_no" | "name" }[] {
  const byReg = new Map<string, OptoutEntry>();
  const byName = new Map<string, OptoutEntry>();
  for (const e of entries) {
    if (e.regNo) byReg.set(e.regNo.replace(/\s+/g, "").toUpperCase(), e);
    if (e.normalised) byName.set(e.normalised, e);
  }
  const out: { customer: CustomerLite; entry: OptoutEntry; via: "reg_no" | "name" }[] = [];
  for (const c of customers) {
    const reg = c.reg_no ? byReg.get(String(c.reg_no).replace(/\s+/g, "").toUpperCase()) : undefined;
    if (reg) {
      out.push({ customer: c, entry: reg, via: "reg_no" });
      continue;
    }
    const names = [c.normalised_name, c.legal_name].filter((n): n is string => typeof n === "string" && n.length > 0).map(normaliseCompanyName);
    const hit = names.map((n) => byName.get(n)).find(Boolean);
    if (hit) out.push({ customer: c, entry: hit, via: "name" });
  }
  return out.sort((a, b) => Number(b.entry.status === "Opted out") - Number(a.entry.status === "Opted out"));
}
