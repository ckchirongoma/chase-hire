/**
 * Four-fifths (80%) rule for adverse impact (docs/09 §9): a group whose selection rate is less
 * than four-fifths of the highest group's rate is flagged for review. A flag is a prompt to
 * review the stage's items and anchors before the next cohort, never a decision about anyone.
 *
 * Only real demographic groups are compared: "not disclosed" and "prefer not to say" are shown
 * but are not groups for this test, and groups suppressed for size (< 30) are left out.
 */

export const FOUR_FIFTHS = 0.8;
export const MIN_GROUP_SIZE = 30;
export const NOT_COMPARED = ["not_disclosed", "prefer_not"] as const;

export type GroupCounts = {
  group: string;
  /** null when the group was suppressed for size. */
  candidates: number | null;
  advanced: number | null;
};

export type FourFifthsRow = GroupCounts & {
  rate: number | null;
  /** This group's rate ÷ the highest compared group's rate. */
  ratio: number | null;
  compared: boolean;
  flagged: boolean;
};

export type FourFifthsResult = {
  rows: FourFifthsRow[];
  reference: { group: string; rate: number } | null;
  flagged: string[];
};

function comparable(g: GroupCounts): g is GroupCounts & { candidates: number; advanced: number } {
  return (
    !(NOT_COMPARED as readonly string[]).includes(g.group) &&
    typeof g.candidates === "number" &&
    typeof g.advanced === "number" &&
    g.candidates >= MIN_GROUP_SIZE &&
    g.advanced >= 0 &&
    g.advanced <= g.candidates
  );
}

/**
 * Adds rates, impact ratios and flags. Comparison is exact (integer cross-multiplication), so a
 * ratio of exactly 0.8 is not flagged. Needs at least two comparable groups and a highest rate
 * above zero; otherwise nothing is compared.
 */
export function fourFifths(groups: readonly GroupCounts[]): FourFifthsResult {
  const pool = groups.filter(comparable);
  let ref: (GroupCounts & { candidates: number; advanced: number }) | null = null;
  for (const g of pool) {
    // a/n > b/m  <=>  a*m > b*n
    if (!ref || g.advanced * ref.candidates > ref.advanced * g.candidates) ref = g;
  }
  const canCompare = pool.length >= 2 && ref !== null && ref.advanced > 0;
  const rows = groups.map((g): FourFifthsRow => {
    const rate = typeof g.candidates === "number" && g.candidates > 0 && typeof g.advanced === "number" ? g.advanced / g.candidates : null;
    const compared = canCompare && comparable(g);
    if (!compared || !ref) return { ...g, rate, ratio: null, compared: false, flagged: false };
    const c = g as GroupCounts & { candidates: number; advanced: number };
    const ratio = (c.advanced * ref.candidates) / (c.candidates * ref.advanced);
    // rate_g / rate_ref < 4/5  <=>  5 * a_g * n_ref < 4 * a_ref * n_g
    const flagged = 5 * c.advanced * ref.candidates < 4 * ref.advanced * c.candidates;
    return { ...g, rate, ratio, compared: true, flagged };
  });
  return {
    rows,
    reference: canCompare && ref ? { group: ref.group, rate: ref.advanced / ref.candidates } : null,
    flagged: rows.filter((r) => r.flagged).map((r) => r.group),
  };
}
