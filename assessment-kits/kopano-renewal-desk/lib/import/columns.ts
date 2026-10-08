/** The monthly base export's columns, exactly as the Network sends them. */
export const BASE_COLUMNS = [
  "Account No",
  "Reg No",
  "Customer Name",
  "Msisdn",
  "dealer_code",
  "Segment",
  "Contract Term",
  "Contract End Date",
  "Contract Status",
  "Month Remaining In Contract",
  "Priceplan",
  "Priceplan Name",
  "Device Type",
  "Device Model",
  "chg_subs",
] as const;

export const OPTOUT_COLUMNS = ["Company", "Date Logged", "Status", "Notes"] as const;

/** The file's structure is not what the import was built for. Nothing is written. */
export class ImportStructureError extends Error {
  constructor(
    message: string,
    readonly missing: string[],
    readonly unexpected: string[],
  ) {
    super(message);
    this.name = "ImportStructureError";
  }
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Fails loudly, naming the columns, when expected columns are missing or renamed or new columns
 * appear. A changed export must be looked at by a person before it touches customer data.
 */
export function checkColumns(headers: string[], expected: readonly string[], fileLabel: string): void {
  const present = headers.filter(Boolean);
  const missing = expected.filter((c) => !present.includes(c));
  const unexpected = present.filter((h) => !expected.includes(h));
  if (!missing.length && !unexpected.length) return;
  const parts: string[] = [];
  const explained = new Set<string>();
  for (const m of missing) {
    const renamed = unexpected.find((u) => !explained.has(u) && (squash(u) === squash(m) || squash(u).startsWith(squash(m).slice(0, 8))));
    if (renamed) explained.add(renamed);
    parts.push(renamed ? `column "${m}" is missing (it looks like it was renamed to "${renamed}")` : `column "${m}" is missing`);
  }
  for (const u of unexpected) if (!explained.has(u)) parts.push(`unexpected new column "${u}"`);
  throw new ImportStructureError(
    `The ${fileLabel} has changed structure: ${parts.join("; ")}. Nothing was imported. Check the export with the Network, then update the import before re-running it.`,
    missing,
    unexpected,
  );
}
