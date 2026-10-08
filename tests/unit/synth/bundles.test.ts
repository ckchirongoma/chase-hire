import { beforeAll, describe, expect, it } from "vitest";
import { BundleAAnswerKey, D_CODES, ExpectedMonth2, fillFigures } from "@/lib/synth/answer-key";
import { BANNED_DIGITS, BANNED_FULL_NAMES, BANNED_TERMS, findBanned, realFigureCollisions } from "@/lib/synth/banned";
import { PRICE_PLANS } from "@/lib/synth/base";
import { buildBundles, scanForBanned, unresolvedPlaceholders, type BuiltFile } from "@/lib/synth";
import { buildBundleA } from "@/lib/synth/bundle-a";
import { buildBundleB } from "@/lib/synth/bundle-b";
import fs from "node:fs";
import path from "node:path";
import { buildBundleC, C_HANDOFF_SOURCE, readHandoffPack } from "@/lib/synth/bundle-c";
import { fillStarterRepoUrl, placeholdersIn } from "@/lib/synth/placeholders";
import { deriveBundleA, diffMonths, msisdnToE164 } from "@/lib/synth/verify";
import { readWorkbook } from "@/lib/synth/xlsx";

const SEED = 20261007;
let files: BuiltFile[];
let key: BundleAAnswerKey;
let expected: ExpectedMonth2;
const file = (p: string) => {
  const f = files.find((x) => x.path === p);
  if (!f) throw new Error(`missing ${p}`);
  return f.content;
};
const json = (p: string) => JSON.parse(file(p).toString("utf8"));

beforeAll(async () => {
  files = await buildBundles({ version: "v1", seed: SEED });
  key = BundleAAnswerKey.parse(json("bundle_a/internal/answer_key.json"));
  expected = ExpectedMonth2.parse(json("bundle_c/internal/expected_month2.json"));
}, 120_000);

describe("generator output", () => {
  it("writes the bundle layout from docs/11, with answer keys only under internal/", () => {
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        "bundle_a/candidate/kopano_vsam_extract.xlsx",
        "bundle_a/internal/answer_key.json",
        "bundle_b/candidate/README.md",
        "bundle_b/candidate/accounts.csv",
        "bundle_b/candidate/agents.csv",
        "bundle_b/candidate/contact_points.csv",
        "bundle_b/candidate/customers.csv",
        "bundle_b/candidate/interactions.csv",
        "bundle_b/candidate/lines.csv",
        "bundle_b/candidate/seed.sql",
        "bundle_b/candidate/solution_brief.md",
        "bundle_b/candidate/templates.csv",
        "bundle_b/internal/meta.json",
        "bundle_c/candidate/HANDOFF.md",
        "bundle_c/candidate/README.md",
        "bundle_c/candidate/base_month1.xlsx",
        "bundle_c/candidate/contacts_agent_sheets.xlsx",
        "bundle_c/candidate/optouts_legal.xlsx",
        "bundle_c/internal/base_month2.xlsx",
        "bundle_c/internal/base_month2_drift.xlsx",
        "bundle_c/internal/expected_month2.json",
        "bundle_d/candidate/data_room.md",
      ].sort(),
    );
    for (const p of paths.filter((x) => x.includes("/candidate/"))) expect(p).not.toMatch(/answer_key|expected|month2|meta/);
  });

  it("is deterministic: the same seed gives the same answer keys; another seed rotates them", async () => {
    const again = await buildBundles({ version: "v1", seed: SEED });
    for (const p of ["bundle_a/internal/answer_key.json", "bundle_c/internal/expected_month2.json", "bundle_b/internal/meta.json"]) {
      expect(again.find((f) => f.path === p)!.content.toString()).toBe(file(p).toString());
    }
    for (const p of ["bundle_b/candidate/seed.sql", "bundle_b/candidate/contact_points.csv"]) {
      expect(again.find((f) => f.path === p)!.content.equals(file(p))).toBe(true);
    }
    const other = await buildBundles({ version: "v2", seed: SEED + 1 });
    const otherKey = JSON.parse(other.find((f) => f.path === "bundle_a/internal/answer_key.json")!.content.toString());
    expect(otherKey.figures.base_lines === key.figures.base_lines && otherKey.figures.funnel_calls === key.figures.funnel_calls).toBe(false);
  }, 120_000);
});

describe("bundle A: every planted defect matches the answer key when re-read from the xlsx", () => {
  let d: Awaited<ReturnType<typeof deriveBundleA>>;
  beforeAll(async () => {
    d = await deriveBundleA(file("bundle_a/candidate/kopano_vsam_extract.xlsx"), key.export_date);
  }, 60_000);

  it("has all 23 D-codes with a summary", () => {
    expect(Object.keys(key.defects).sort()).toEqual(D_CODES);
    for (const c of D_CODES) expect(key.defects[c].summary.length).toBeGreaterThan(20);
  });

  it("counts per D-code agree with the cells", () => {
    for (const c of D_CODES) {
      if (key.defects[c].kind === "count" || d.counts[c] !== null) expect([c, d.counts[c]]).toEqual([c, key.defects[c].count]);
    }
  });

  it("details agree with the cells", () => {
    const k = (c: string) => key.defects[c].details as Record<string, unknown>;
    expect(d.details.D01).toMatchObject({ lines: k("D01").lines, accounts: k("D01").accounts, has_reg_or_customer_id: false });
    expect(d.details.D02.base_has_contact_columns).toBe(false);
    expect(d.details.D03).toEqual({ exact_pairs: 5, normalised_pairs: 7 });
    for (const f of ["bracket_style", "stripped_integer", "zero_placeholder", "landline", "other_format"]) expect([f, d.details.D05[f]]).toEqual([f, k("D05")[f]]);
    expect(d.details.D06).toEqual({ holder_zero: k("D06").holder_zero, email_blank: k("D06").email_blank });
    expect(d.details.D07).toEqual({ number_cells: k("D07").number_cells, string_cells: k("D07").string_cells });
    for (const f of ["us_style", "padded_ambiguous", "yyyy_dd_mm", "impossible", "excel_dates", "blanks"]) expect([f, d.details.D08[f]]).toEqual([f, k("D08")[f]]);
    expect(d.details.D08.impossible).toBe(3);
    expect(d.details.D09).toMatchObject({ date_cells: k("D09").date_cells, text_zero: k("D09").text_zero });
    expect(d.details.D13).toEqual({ trailing_space_rows: k("D13").trailing_space_rows, column_f_header: null });
    expect(d.details.D14).toEqual({ next_action_empty: key.figures.worksheet_accounts, action_required_empty: key.figures.worksheet_accounts });
    expect(d.details.D15).toEqual({ processing: 1, approved: 1, application_status_blank: k("D15").application_status_blank });
    expect(d.details.D16.done_on_dead_calls).toBe(k("D16").done_on_dead_calls);
    expect(d.details.D17.matched_accounts).toBe(k("D17").matched_accounts);
    expect(d.details.D18).toEqual({ constant_base_columns: ["Telemetry", "Region", "Channel", "RSM", "AM"], am_base: k("D18").am_base, am_dialler: k("D18").am_dialler });
    expect(d.details.D19.has_msisdn_or_timestamp).toBe(false);
    expect(d.details.D20).toEqual({ test_or_system_users: expect.arrayContaining(["test 23", "Dialler Support"]), interval_agents: 4 });
    expect(d.details.D21).toEqual({ trailing_space_headers: k("D21").trailing_space_headers, target_string: ["104 / 52 / 21 / 6"], day_status_filled: k("D21").day_status_filled });
    expect(d.details.D22).toEqual({ calls: key.figures.funnel_calls, connected: key.figures.funnel_connected, opportunities: key.figures.funnel_opportunities, sales: key.figures.funnel_sales });
    expect(d.details.D23.consent_columns).toEqual([]);
  });

  it("row identifiers in the key point at the right rows", async () => {
    const wb = await readWorkbook(file("bundle_a/candidate/kopano_vsam_extract.xlsx"));
    const ws = wb.get("worksheet")!;
    const base = wb.get("vsam base raw")!;
    const wsRow = (n: number) => ws.rows.find((r) => r.rowNumber === n)!.cells;
    const baseRow = (n: number) => base.rows.find((r) => r.rowNumber === n)!.cells;
    for (const n of key.defects.D14.rows!) expect(wsRow(n)[4]).toBe("Call back / Follow up");
    for (const n of key.defects.D15.rows!) expect(wsRow(n)[4]).toBe("Engaged Requested quote");
    for (const n of key.defects.D06.rows!) expect(wsRow(n)[2]).toBe(0);
    for (const n of key.defects.D10.rows!) expect((baseRow(n)[12] as Date).getUTCFullYear()).toBe(1970);
    for (const n of key.defects.D11.rows!) expect(baseRow(n)[13]).toBe("InContract");
    const impossible = (key.defects.D08.details as { impossible_rows: number[] }).impossible_rows;
    for (const n of impossible) expect(String(wsRow(n)[8])).toMatch(/^2026\/(1[3-9]|2\d)\/0[89]$/);
  });

  it("derived figures used by the gold answer match the cells", () => {
    for (const f of ["base_lines", "base_accounts", "worksheet_accounts", "window_lines", "window_accounts", "window_charges_zar", "incontract_expired", "lines_per_account_median", "lines_per_account_max"] as const) {
      expect([f, d.figures[f]]).toEqual([f, key.figures[f]]);
    }
    expect(key.figures.target_sales_month).toBe(6 * 4 * 22);
    expect(key.figures.window_accounts_in_worksheet).toBeLessThanOrEqual(key.figures.window_accounts as number);
  });

  it("proportions are within tolerance of docs/11", () => {
    const f = d.figures;
    const s = d.shares;
    expect(f.base_lines).toBeGreaterThan(4700);
    expect(f.base_lines).toBeLessThan(5300);
    expect(f.base_accounts).toBeGreaterThan(1250);
    expect(f.base_accounts).toBeLessThan(1450);
    expect(f.lines_per_account_median).toBe(2);
    expect(f.lines_per_account_max).toBeGreaterThanOrEqual(64);
    expect(f.lines_per_account_max).toBeLessThanOrEqual(72);
    expect(s.sme).toBeGreaterThan(0.96);
    expect(s.le).toBeGreaterThan(0.005);
    expect(s.le).toBeLessThan(0.03);
    expect(s.pe).toBeLessThan(0.012);
    expect(s.term_24).toBeGreaterThan(0.56);
    expect(s.term_24).toBeLessThan(0.7);
    expect(s.term_36).toBeGreaterThan(0.27);
    expect(s.term_36).toBeLessThan(0.39);
    expect(s.term_short).toBeGreaterThan(0.01);
    expect(s.term_short).toBeLessThan(0.08);
    expect(s.out_of_contract).toBeGreaterThan(0.27);
    expect(s.out_of_contract).toBeLessThan(0.39);
    expect(s.window).toBeGreaterThan(0.06);
    expect(s.window).toBeLessThan(0.12);
    expect(f.chg_median).toBeGreaterThan(250);
    expect(f.chg_median).toBeLessThan(370);
    expect(f.chg_q1).toBeGreaterThan(110);
    expect(f.chg_q1).toBeLessThan(220);
    expect(f.chg_q3).toBeGreaterThan(440);
    expect(f.chg_q3).toBeLessThan(620);
    expect(f.chg_max).toBeGreaterThan(2600);
    expect(f.chg_max).toBeLessThanOrEqual(2700);
    expect(s.chg_zero).toBeGreaterThan(0.04);
    expect(s.chg_zero).toBeLessThan(0.08);
    expect(s.chg_blank).toBeGreaterThan(0.002);
    expect(s.chg_blank).toBeLessThan(0.012);
    expect(s.no_device).toBeGreaterThan(0.32);
    expect(s.no_device).toBeLessThan(0.42);
    expect(f.worksheet_accounts).toBeGreaterThanOrEqual(115);
    expect(f.worksheet_accounts).toBeLessThanOrEqual(135);
    expect(s.worksheet_of_accounts).toBeGreaterThan(0.075);
    expect(s.worksheet_of_accounts).toBeLessThan(0.11);
    expect(s.contact_bracket).toBeGreaterThan(0.62);
    expect(s.contact_bracket).toBeLessThan(0.78);
    expect(s.contact_stripped).toBeGreaterThan(0.08);
    expect(s.contact_stripped).toBeLessThan(0.16);
    expect(s.contact_zero).toBeGreaterThan(0.09);
    expect(s.contact_zero).toBeLessThan(0.17);
    expect(s.holder_zero).toBeGreaterThan(0.49);
    expect(s.holder_zero).toBeLessThan(0.59);
    expect(s.email_blank).toBeGreaterThan(0.5);
    expect(s.email_blank).toBeLessThan(0.6);
    expect(s.done).toBeGreaterThan(0.84);
    expect(s.done).toBeLessThan(0.92);
    expect(s.ooc_drift).toBeGreaterThan(0.02);
    expect(s.ooc_drift).toBeLessThan(0.07);
    expect(key.defects.D11.count).toBeGreaterThanOrEqual(95);
    expect(key.defects.D11.count).toBeLessThanOrEqual(115);
    expect(f.dialler_rows).toBe(19);
    expect(f.interval_rows).toBe(88);
    expect(key.figures.funnel_calls).toBeGreaterThanOrEqual(1600);
    expect(key.figures.funnel_calls).toBeLessThanOrEqual(1800);
    expect(key.figures.funnel_connected).toBeGreaterThanOrEqual(800);
    expect(key.figures.funnel_connected).toBeLessThanOrEqual(940);
    expect(key.figures.funnel_opportunities).toBeGreaterThanOrEqual(65);
    expect(key.figures.funnel_opportunities).toBeLessThanOrEqual(85);
    expect(key.figures.funnel_sales).toBeGreaterThanOrEqual(18);
    expect(key.figures.funnel_sales).toBeLessThanOrEqual(26);
    // D08 scaled from 111 / 16 / 16 (of 143) to the worksheet's real row count.
    const n = key.figures.worksheet_accounts as number;
    const d08 = key.defects.D08.details as Record<string, number>;
    expect(d08.text_dates + d08.excel_dates + d08.blanks).toBe(n);
    expect(Math.abs(d08.text_dates - (n * 111) / 143)).toBeLessThanOrEqual(1);
    expect(Math.abs(d08.excel_dates - (n * 16) / 143)).toBeLessThanOrEqual(1);
  });

  it("fills gold-answer figure tokens from this bundle and never guesses missing ones", () => {
    expect(fillFigures("{{window_lines}} lines, {{window_charges_zar}} a month, {{window_accounts_in_worksheet_pct}} in the sheet", key.figures)).toBe(
      `${Number(key.figures.window_lines).toLocaleString("en-US")} lines, R${Math.round(Number(key.figures.window_charges_zar)).toLocaleString("en-US")} a month, ${key.figures.window_accounts_in_worksheet_pct}% in the sheet`,
    );
    expect(fillFigures("{{nope}}", key.figures)).toBe("[bundle figure: nope]");
    expect(fillFigures("{{base_lines}}", null)).toBe("[bundle figure: base_lines]");
  });
});

describe("no real names or values", () => {
  it("finds nothing banned in any generated file, and no figure equals the real extract's", async () => {
    expect(await scanForBanned(files)).toEqual([]);
    expect(realFigureCollisions(key.figures)).toEqual([]);
  }, 60_000);

  it("the scanner itself catches every banned term and digit run", () => {
    for (const t of BANNED_TERMS) expect(findBanned(`x ${t.toUpperCase()} y`)).not.toEqual([]);
    for (const t of BANNED_DIGITS) expect(findBanned(`(083) ${t}`)).not.toEqual([]);
    expect(findBanned("Masakhane Trading CC, Lesedi Holdings (Pty) Ltd")).toEqual([]);
    // Full names in any order or separator, including email-style local parts.
    for (const n of BANNED_FULL_NAMES) {
      const [first, last] = n.split(" ");
      for (const form of [n, `${last}, ${first}`, `${first.toLowerCase()}.${last.toLowerCase()}@example.co.za`, `${first}_${last}`]) {
        expect([form, findBanned(`x ${form} y`).length > 0]).toEqual([form, true]);
      }
    }
    expect(findBanned("Johan Swanepoel")).not.toEqual([]);
    expect(findBanned("Stella Mokoena and Mike Dlamini")).toEqual([]);
  });

  it("never draws a context person's name: every surname and first name in context/ is off the pools", async () => {
    const { FIRST_NAMES, SURNAMES } = await import("@/lib/synth/names");
    const pool = new Set<string>([...FIRST_NAMES, ...SURNAMES].map((x) => x.toLowerCase()));
    for (const n of BANNED_FULL_NAMES) {
      const [first, last] = n.split(" ");
      expect([n, pool.has(last.toLowerCase())]).toEqual([n, false]);
      // A first name may stay in the pool only when its surname is banned (so the full name can't occur).
      if (pool.has(first.toLowerCase())) expect(findBanned(last)).not.toEqual([]);
    }
    expect(pool.has("swanepoel") || pool.has("johan")).toBe(false);
  });

  it("uses fictional email domains only", () => {
    for (const f of files.filter((x) => /\.(csv|sql|md|json)$/.test(x.path))) {
      const emails = f.content.toString("utf8").match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? [];
      for (const e of emails) expect(e).toMatch(/@example\.co\.za$/);
    }
  });
});

describe("bundle B (cleaned data)", () => {
  const csv = (name: string) => {
    const [head, ...rows] = file(`bundle_b/candidate/${name}.csv`).toString("utf8").trim().split("\n");
    const cols = head.split(",");
    return rows.map((r) => {
      const cells = r.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
      return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
    });
  };

  it("has about 45% contactable customers (verified + consented contact point)", () => {
    const customers = csv("customers");
    const points = csv("contact_points");
    const ok = new Set(points.filter((p) => p.verified_at && ["opted_in", "existing_customer_s69_3"].includes(p.consent_status)).map((p) => p.customer_id));
    const share = ok.size / customers.length;
    expect(share).toBeGreaterThan(0.4);
    expect(share).toBeLessThan(0.5);
    expect(share).toBeLessThan(0.6); // below the Solution Brief's gate on purpose
    for (const p of points) {
      expect(["mobile", "landline", "email", "whatsapp"]).toContain(p.type);
      if (p.type !== "email") expect(p.value).toMatch(/^\+27\d{9}$/);
    }
  });

  it("applies the H07 eligibility rule and derives status from the end date", () => {
    const plans = new Map(PRICE_PLANS.map((p) => [p.name, p]));
    for (const l of csv("lines")) {
      expect(l.msisdn_e164).toMatch(/^\+27[6-8]\d{8}$/);
      if (!l.contract_end_date) {
        expect(l.status).toBe("unknown");
        expect(l.eligible_from).toBe("");
        continue;
      }
      const end = new Date(`${l.contract_end_date}T00:00:00Z`);
      expect(l.status).toBe(end < new Date("2026-10-07T00:00:00Z") ? "out_of_contract" : "in_contract");
      const months = plans.get(l.priceplan)!.lastMonthOnly ? 1 : 3;
      const e = new Date(`${l.eligible_from}T00:00:00Z`);
      const diff = (end.getUTCFullYear() - e.getUTCFullYear()) * 12 + end.getUTCMonth() - e.getUTCMonth();
      expect(diff).toBe(months);
    }
  });

  it("has about 300 interactions and a seed.sql covering every table", () => {
    const n = csv("interactions").length;
    expect(n).toBeGreaterThanOrEqual(280);
    expect(n).toBeLessThanOrEqual(320);
    const sql = file("bundle_b/candidate/seed.sql").toString();
    for (const t of ["customers", "accounts", "lines", "contact_points", "agents", "interactions", "templates"]) {
      expect(sql).toContain(`create table if not exists public.${t}`);
      expect(sql).toContain(`insert into public.${t} (`);
    }
    expect(file("bundle_b/candidate/solution_brief.md").toString()).toContain("Bulk outreach is out of scope until the contactable share passes 60%.");
  });
});

describe("bundle C (SWE Test 1)", () => {
  it("month-2 deltas re-read from the xlsx match expected_month2.json", async () => {
    const diff = await diffMonths(file("bundle_c/candidate/base_month1.xlsx"), file("bundle_c/internal/base_month2.xlsx"));
    const m2 = expected.month2;
    expect(diff.month1Lines).toBe(expected.month1.lines);
    expect(diff.month2FileRows).toBe(m2.file_rows);
    expect(diff.month2Active).toBe(m2.lines_after_active);
    expect(diff.newLines.sort()).toEqual([...(m2.new_msisdns as string[])].sort());
    expect(diff.removedLines.sort()).toEqual([...(m2.removed_msisdns as string[])].sort());
    expect(diff.changedLines.sort()).toEqual((m2.changed as { msisdn_e164: string }[]).map((c) => c.msisdn_e164).sort());
    expect(diff.duplicateRows).toBe(30);
    expect(diff.ambiguousDateRows).toBe(10);
    expect(m2).toMatchObject({ duplicate_rows: 30, phone_defect_rows: 20, ambiguous_date_rows: 10, lines_new_for_existing_customers: 15 });
    const n1 = expected.month1.file_rows as number;
    expect(Math.abs(m2.lines_changed - n1 * 0.04)).toBeLessThanOrEqual(1);
    expect(Math.abs(m2.lines_new - n1 * 0.02)).toBeLessThanOrEqual(1);
    expect(Math.abs(m2.lines_removed - n1 * 0.015)).toBeLessThanOrEqual(1);
    expect(m2.customers_after).toBe((expected.month1.customers as number) + m2.new_customers);
  }, 60_000);

  it("phone-format drift rows normalise to existing lines (no new lines from formatting)", async () => {
    const wb = await readWorkbook(file("bundle_c/internal/base_month2.xlsx"));
    const s = wb.get("vsam base raw")!;
    const rows = new Map(s.rows.map((r) => [r.rowNumber, r.cells]));
    const newSet = new Set(expected.month2.new_msisdns as string[]);
    for (const n of expected.month2.phone_defect_row_numbers as number[]) {
      const e164 = msisdnToE164(rows.get(n)![3]);
      expect(e164).toMatch(/^\+27\d{9}$/);
      expect(newSet.has(e164!)).toBe(false);
    }
  });

  it("the drift file renames one column and adds one", async () => {
    const wb = await readWorkbook(file("bundle_c/internal/base_month2_drift.xlsx"));
    const h = wb.get("vsam base raw")!.headers;
    expect(h).toContain("Contract_End");
    expect(h).not.toContain("Contract End Date");
    expect(h[h.length - 1]).toBe("Sales_Rep");
  });

  it("month 1 has a ~92% populated Reg No, phones stored as numbers, epoch and stale defects", async () => {
    const wb = await readWorkbook(file("bundle_c/candidate/base_month1.xlsx"));
    const s = wb.get("vsam base raw")!;
    const regShare = s.rows.filter((r) => r.cells[1] !== null).length / s.rows.length;
    expect(regShare).toBeGreaterThan(0.86);
    expect(regShare).toBeLessThan(0.97);
    expect(s.rows.filter((r) => typeof r.cells[3] === "number" && r.cells[3] !== 0).length / s.rows.length).toBeGreaterThan(0.8);
    expect((expected.month1.epoch_rows as number[]).length).toBeGreaterThan(0);
    expect(expected.month1.stale_incontract_rows).toBeGreaterThan(0);
    expect(expected.sentinels).toHaveLength(5);
  });

  it("the opt-out list has ~40 company-name-only rows with variants, mapped in the internal key", async () => {
    const wb = await readWorkbook(file("bundle_c/candidate/optouts_legal.xlsx"));
    const s = [...wb.values()][0];
    expect(s.headers).toEqual(["Company", "Date Logged", "Status", "Notes"]);
    expect(s.rows.length).toBeGreaterThanOrEqual(38);
    expect(s.rows.length).toBeLessThanOrEqual(42);
    const optouts = expected.optouts as { matches: { listed_name: string; account_nos: number[] }[] };
    expect(optouts.matches.length).toBeGreaterThanOrEqual(35);
    for (const m of optouts.matches) expect(m.account_nos.length).toBeGreaterThan(0);
    const contacts = await readWorkbook(file("bundle_c/candidate/contacts_agent_sheets.xlsx"));
    expect(contacts.size).toBe(3);
  });

  it("leaves the starter-repo placeholder only when no link is given, and flags it as unresolved", async () => {
    expect(file("bundle_c/candidate/README.md").toString()).toContain("STARTER_REPO_URL");
    expect(unresolvedPlaceholders(files)).toEqual([{ path: "bundle_c/candidate/README.md", placeholders: ["STARTER_REPO_URL"] }]);
    const filled = await buildBundles({ version: "v1", seed: SEED, starterRepoUrl: "https://github.com/example-org/renewal-desk-starter" });
    const readme = filled.find((f) => f.path === "bundle_c/candidate/README.md")!.content.toString();
    expect(readme).toContain("https://github.com/example-org/renewal-desk-starter");
    expect(placeholdersIn(readme)).toEqual([]);
    expect(unresolvedPlaceholders(filled)).toEqual([]);
    expect(() => fillStarterRepoUrl("x STARTER_REPO_URL", "http://example.com/starter")).toThrow(/github/);
    expect(() => fillStarterRepoUrl("x STARTER_REPO_URL", "not a url")).toThrow();
  }, 120_000);

  it("tells candidates how to reach the starter and that their copy must be public (the platform reads it without signing in)", () => {
    const readme = file("bundle_c/candidate/README.md").toString();
    expect(readme).toMatch(/public repository: all you need is a GitHub account/);
    expect(readme).toMatch(/whole history/);
    expect(readme).toMatch(/Make your repository \*\*public\*\*/);
    expect(readme).toMatch(/Do not use GitHub's "Use this template" button/);
  });
});

describe("bundle C handoff pack", () => {
  it("ships assessment-kits/HANDOFF.md unchanged as a candidate file, listed in the README", () => {
    const handoff = file("bundle_c/candidate/HANDOFF.md").toString();
    expect(handoff).toBe(fs.readFileSync(path.resolve(C_HANDOFF_SOURCE), "utf8"));
    for (let n = 1; n <= 12; n++) expect(handoff).toContain(`RD-${String(n).padStart(2, "0")}`);
    expect(handoff).toMatch(/### RD-07 [^\n]*\(must\)/);
    expect(handoff).toMatch(/### RD-11 [^\n]*\(must\)/);
    expect(handoff).toMatch(/\*\*Given\*\*[^\n]*\*\*when\*\*[^\n]*\*\*then\*\*/);
    expect(handoff).toContain("BZF150");
    expect(handoff).toContain("## 5. Access matrix");
    expect(findBanned(handoff)).toEqual([]);
    expect(placeholdersIn(handoff)).toEqual([]);
    expect(file("bundle_c/candidate/README.md").toString()).toContain("`HANDOFF.md`");
  });

  it("does not leak the internal answer key or harness contract into the handoff pack", () => {
    const handoff = file("bundle_c/candidate/HANDOFF.md").toString();
    expect(handoff).not.toMatch(/\bF(0[1-9]|1[0-4])\b|planted|verification_runs|harness|month[ _-]?2|expected_month2/i);
  });

  it("finds the pack from a subfolder, accepts an override, and fails clearly outside the repository", () => {
    expect(readHandoffPack(path.resolve("lib/synth"))).toBe(readHandoffPack());
    expect(buildBundleC(SEED, "vtest", { handoffMd: "# test pack" }).handoff).toBe("# test pack");
    expect(() => readHandoffPack(path.parse(process.cwd()).root)).toThrow(/HANDOFF\.md not found/);
  });
});

describe("bundle D", () => {
  it("is the data room text only", () => {
    const md = file("bundle_d/candidate/data_room.md").toString();
    expect(md).toContain("about 40% done");
    expect(md).toContain("300 stem downloads a day");
    expect(md).not.toMatch(/R\s?525|20.?35k|proposal/i);
  });
});

describe("generator robustness across seeds (docs/11: a new seed every cohort)", () => {
  it("builds bundles A, B and C for 50 seeds without crashing, with sparse Day Status never equal to the real 8", () => {
    const dayStatus = new Set<number>();
    const failures: string[] = [];
    for (let seed = 1; seed <= 50; seed++) {
      try {
        const a = buildBundleA(seed, "vtest");
        dayStatus.add((a.answerKey.defects.D21.details as { day_status_filled: number }).day_status_filled);
        expect(Object.keys(a.answerKey.defects).sort()).toEqual(D_CODES);
        expect(realFigureCollisions(a.answerKey.figures)).toEqual([]);
        buildBundleB(a, seed, "vtest");
        const c = buildBundleC(seed, "vtest");
        expect(c.expected.month2.lines_new).toBeGreaterThan(c.expected.month2.lines_new_for_existing_customers);
        const accounts = c.expected.month2.new_customer_accounts as { lines: number }[];
        expect(accounts.reduce((s, x) => s + x.lines, 0)).toBe(c.expected.month2.lines_new - c.expected.month2.lines_new_for_existing_customers);
      } catch (err) {
        failures.push(`seed ${seed}: ${(err as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
    expect(dayStatus.has(8)).toBe(false);
    expect(dayStatus.size).toBeGreaterThan(2);
  }, 120_000);

  it("writes clean files (no banned names or values) for a few other seeds", async () => {
    for (const seed of [1, 39, 57]) {
      const built = await buildBundles({ version: "v9", seed });
      expect([seed, await scanForBanned(built)]).toEqual([seed, []]);
    }
  }, 180_000);
});
