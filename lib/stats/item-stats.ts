/**
 * Reasoning item statistics (docs/04 §4). difficulty_p is the proportion correct, discrimination
 * the (corrected) point-biserial, both recomputed nightly by refresh_reasoning_item_stats() and
 * counted only after 40 exposures.
 *
 * - Retire: discrimination below .15, or p above .90 or below .08.
 * - Off target: p outside its tier's band (easy .65–.80, medium .30–.50, hard .15–.30), which
 *   is what keeps the median applicant near 40–50%.
 */

export type Tier = "easy" | "medium" | "hard";

export const ITEM_RULES = {
  minExposures: 40,
  minDiscrimination: 0.15,
  maxP: 0.9,
  minP: 0.08,
} as const;

export const TIER_TARGET_P: Record<Tier, readonly [number, number]> = {
  easy: [0.65, 0.8],
  medium: [0.3, 0.5],
  hard: [0.15, 0.3],
};

export type ItemStatus = "insufficient" | "ok" | "off_target" | "retire";

export type ItemCheck = { status: ItemStatus; reasons: string[] };

const n = (x: number | string | null | undefined): number | null => {
  if (x === null || x === undefined || x === "") return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
};

/** Classifies one item template; numeric columns may arrive as strings from PostgREST. */
export function checkItem(item: {
  tier: string;
  exposures: number | string | null;
  difficulty_p: number | string | null;
  discrimination: number | string | null;
}): ItemCheck {
  const exposures = n(item.exposures) ?? 0;
  const p = n(item.difficulty_p);
  const d = n(item.discrimination);
  if (exposures < ITEM_RULES.minExposures || p === null) {
    return { status: "insufficient", reasons: [`${exposures} of ${ITEM_RULES.minExposures} exposures needed`] };
  }
  const retire: string[] = [];
  if (d !== null && d < ITEM_RULES.minDiscrimination) retire.push(`discrimination ${d.toFixed(2)} < ${ITEM_RULES.minDiscrimination}`);
  if (d === null) retire.push("discrimination undefined (everyone scored the same)");
  if (p > ITEM_RULES.maxP) retire.push(`p ${p.toFixed(2)} > ${ITEM_RULES.maxP}`);
  if (p < ITEM_RULES.minP) retire.push(`p ${p.toFixed(2)} < ${ITEM_RULES.minP}`);
  if (retire.length) return { status: "retire", reasons: retire };
  const band = TIER_TARGET_P[item.tier as Tier];
  if (band && (p < band[0] || p > band[1])) {
    return { status: "off_target", reasons: [`p ${p.toFixed(2)} outside the ${item.tier} band ${band[0]}–${band[1]}`] };
  }
  return { status: "ok", reasons: [] };
}
