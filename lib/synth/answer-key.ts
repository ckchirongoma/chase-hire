import { z } from "zod";

/**
 * Shapes of the INTERNAL answer keys the generator writes next to each bundle
 * (datasets/<version>/bundle_x/internal/). Graders read these so scores follow the bundle the
 * candidate actually received (docs/11 "Answer-key generation"). No exceljs here: this module is
 * imported by server code.
 */

export const DefectEntry = z
  .object({
    id: z.string(),
    kind: z.enum(["structural", "count"]),
    sheet: z.string().nullable(),
    columns: z.array(z.string()).default([]),
    count: z.number().nullable(),
    /** One line a grader can compare a candidate's evidence against. */
    summary: z.string(),
    details: z.record(z.string(), z.unknown()).default({}),
    /** Excel row numbers (header = row 1) of the affected rows, where countable. */
    rows: z.array(z.number()).optional(),
    accounts: z.array(z.number()).optional(),
  })
  .passthrough();
export type DefectEntry = z.output<typeof DefectEntry>;

export const BundleAAnswerKey = z
  .object({
    bundle: z.literal("bundle_a"),
    version: z.string(),
    seed: z.number(),
    export_date: z.string(),
    file: z.string(),
    sheets: z.record(z.string(), z.object({ name: z.string(), rows: z.number(), columns: z.array(z.string().nullable()) }).passthrough()),
    /** Derived figures used by the gold answer (doc 13), e.g. window_lines, window_charges_zar. */
    figures: z.record(z.string(), z.union([z.number(), z.string()])),
    defects: z.record(z.string(), DefectEntry),
  })
  .passthrough();
export type BundleAAnswerKey = z.output<typeof BundleAAnswerKey>;

export const D_CODES = Array.from({ length: 23 }, (_, i) => `D${String(i + 1).padStart(2, "0")}`);

/**
 * Replaces {{figure}} tokens (doc 13 gold-answer excerpts stored in rubrics.reference) with this
 * bundle's figures. Unknown tokens become "[bundle figure: name]" so a grader never sees a
 * number that belongs to another bundle.
 */
export function fillFigures(text: string, figures: Record<string, number | string> | null | undefined): string {
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, name: string) => {
    const v = figures?.[name];
    if (v === undefined || v === null) return `[bundle figure: ${name}]`;
    return typeof v === "number" ? formatFigure(name, v) : v;
  });
}

function formatFigure(name: string, v: number): string {
  if (name.endsWith("_zar")) return `R${Math.round(v).toLocaleString("en-US")}`;
  if (name.endsWith("_pct")) return `${Math.round(v * 10) / 10}%`;
  return Number.isInteger(v) ? v.toLocaleString("en-US") : String(Math.round(v * 100) / 100);
}

/** Expected post-import state for SWE Test 1's month-2 harness (bundle C, internal). */
export const ExpectedMonth2 = z
  .object({
    bundle: z.literal("bundle_c"),
    version: z.string(),
    seed: z.number(),
    month1: z.object({ customers: z.number(), accounts: z.number(), lines: z.number() }).passthrough(),
    month2: z
      .object({
        file_rows: z.number(),
        customers_after: z.number(),
        new_customers: z.number(),
        lines_after_active: z.number(),
        lines_new: z.number(),
        lines_new_for_existing_customers: z.number(),
        lines_changed: z.number(),
        lines_removed: z.number(),
        duplicate_rows: z.number(),
        phone_defect_rows: z.number(),
        ambiguous_date_rows: z.number(),
      })
      .passthrough(),
    sentinels: z.array(z.object({ account_no: z.number(), reg_no: z.string().nullable(), name: z.string() }).passthrough()),
  })
  .passthrough();
export type ExpectedMonth2 = z.output<typeof ExpectedMonth2>;
