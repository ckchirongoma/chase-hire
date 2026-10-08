/**
 * Real names and values that must never reach a candidate (CLAUDE.md hard rule 6). The
 * generator checks every file it writes against this list and refuses to write on a hit.
 */

/**
 * Client, network, vendor, label, partner and people names from the internal context (word
 * match, any case). Surnames and distinctive first names are banned on their own, so a generated
 * person can never carry them; common first names (Mike, Ian, Stella, ...) are caught in
 * BANNED_FULL_NAMES instead.
 */
export const BANNED_TERMS = [
  // Organisations and products
  "Cosmo", "MTN", "Solgari", "Everlytic", "Gallo", "Ingrooves", "Virgin", "Aurachain", "FraudWatch", "Liberty",
  "Content Connect Africa", "charles.xlsx",
  // People (context/client-context.md, context/cosmo-defect-catalogue.md)
  "Thokozani", "Mbuso", "Nlhapo", "Nhlapo", "Swanepoel", "Hiscock", "Mpanya", "Osrin", "Munashe", "Antos",
] as const;

/** Full names of real people in the internal context, matched in either order and with ., _ or - between the parts. */
export const BANNED_FULL_NAMES = [
  "Thokozani Nhlapo", "Mbuso Nlhapo", "Johan Swanepoel", "Marcus Hiscock", "Mike Mpanya", "Ian Osrin", "Munashe Moyo", "Antos Stella",
] as const;

/** Digit runs of real phone numbers quoted in the internal docs. */
export const BANNED_DIGITS = ["2728600", "612327731"] as const;

/** Real-extract figures a bundle's derived figures must never equal (structure only, never values). */
export const REAL_FIGURES: Record<string, number> = {
  base_lines: 5114,
  base_accounts: 1377,
  worksheet_accounts: 127,
  incontract_expired: 107,
  holder_zero: 69,
  window_lines: 473,
  window_accounts: 224,
  window_charges_zar: 158855,
  funnel_calls: 1687,
  funnel_connected: 865,
  funnel_opportunities: 76,
  funnel_sales: 22,
};

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEP = "[\\s._-]+";
const nameParts = (n: string) => n.split(/\s+/).map(escapeRe);
const TERMS = [
  ...BANNED_TERMS.map((t) => nameParts(t).join(SEP)),
  ...BANNED_FULL_NAMES.flatMap((n) => [nameParts(n).join(SEP), [...nameParts(n)].reverse().join(`,?${SEP}`)]),
];
const TERM_RE = new RegExp(`(?:^|[^a-z0-9])(${TERMS.join("|")})(?=$|[^a-z0-9])`, "i");

/** Returns every banned term or digit run found in `text`. */
export function findBanned(text: string): string[] {
  const hits = new Set<string>();
  const m = text.match(new RegExp(TERM_RE.source, "gi"));
  for (const h of m ?? []) hits.add(h.replace(/^[^a-z0-9]/i, ""));
  for (const d of BANNED_DIGITS) if (text.includes(d)) hits.add(d);
  return [...hits];
}

/** Figures that collide with the real extract. */
export function realFigureCollisions(figures: Record<string, number | string>): string[] {
  return Object.entries(REAL_FIGURES)
    .filter(([k, v]) => Math.round(Number(figures[k])) === v)
    .map(([k]) => k);
}
