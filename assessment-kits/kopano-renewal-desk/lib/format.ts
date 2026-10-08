const rand = new Intl.NumberFormat("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Rands, e.g. R1 234.50. */
export function rands(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "–";
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? `R${rand.format(n)}` : "–";
}

export function day(v: string | null | undefined): string {
  if (!v) return "–";
  return v.slice(0, 10);
}

export function dateTime(v: string | null | undefined): string {
  if (!v) return "–";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "–";
  return d.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", dateStyle: "medium", timeStyle: "short" });
}

export const CONSENT_LABELS: Record<string, string> = {
  opted_in: "Opted in",
  existing_customer_s69_3: "Existing customer (utility only)",
  opted_out: "Opted out",
  unknown: "Unknown",
};
