import { systemOne } from "@/lib/jev";
import type { ParsedCv } from "@/lib/cv/schema";
import {
  CLAIMS_PER_INTERVIEW,
  GENERIC_TOPICS,
  logisticsQuestion,
  PROBES,
  situationalQuestion,
  starQuestion,
  WARMUP_QUESTION,
} from "./script";
import type { InterviewPlan, PlanClaim, PlanQuestion, PlanSelection } from "./types";

/**
 * Builds the per-candidate interview script from the parsed CV (docs/05 Part A):
 *   (a) the most recent role's first claim,
 *   (b) the most impressive quantified claim (JEV choice; fallback: the longest quantified claim),
 *   (c) the claim closest to the role spec (JEV choice; fallback: keyword overlap).
 * De-duplicated, then filled from the remaining claims, then role titles, then generic topics.
 * JEV only picks between claims the candidate wrote; it never writes question text.
 */

export interface RoleInfo {
  slug: string;
  title: string;
  summary: string;
  spec_md: string;
  salary_min: number;
  salary_max: number;
  location_note?: string | null;
}

export interface FlatClaim {
  id: string;
  text: string;
  quantified: boolean;
  skills: string[];
  roleTitle: string | null;
  employer: string | null;
  /** Position in recency order (0 = most recent). */
  rank: number;
}

type CvRole = ParsedCv["roles"][number];

const PRESENT = /^(present|current|now|ongoing|to date|today)$/i;

function dateKey(v: string | null): string | null {
  if (!v) return null;
  if (PRESENT.test(v.trim())) return "9999-12";
  const m = v.match(/(\d{4})(?:[-/.](\d{1,2}))?/);
  return m ? `${m[1]}-${(m[2] ?? "12").padStart(2, "0")}` : null;
}

/**
 * Roles from most to least recent. Sorted by end then start date when every role has a usable
 * date; otherwise the CV's own order is kept (CVs are normally reverse-chronological).
 */
export function rolesByRecency(roles: readonly CvRole[]): CvRole[] {
  const keyed = roles.map((r, i) => ({ r, i, end: dateKey(r.end) ?? dateKey(r.start), start: dateKey(r.start) ?? "" }));
  if (keyed.some((k) => k.end === null)) return [...roles];
  return keyed
    .sort((a, b) => (b.end! > a.end! ? 1 : b.end! < a.end! ? -1 : b.start > a.start ? 1 : b.start < a.start ? -1 : a.i - b.i))
    .map((k) => k.r);
}

export function flattenClaims(cv: ParsedCv | null): FlatClaim[] {
  if (!cv) return [];
  let rank = 0;
  return rolesByRecency(cv.roles).flatMap((role) =>
    role.claims.map((c) => ({
      id: c.id,
      text: c.text,
      quantified: c.quantified,
      skills: c.skills,
      roleTitle: role.title,
      employer: role.employer,
      rank: rank++,
    })),
  );
}

const STOPWORDS = new Set(
  "the and for with from that this into over under your our their they them you are was were has have had will would can could should about across within using used use per via not but all any each more most less than then also both such other its it's who what when where which while how a an to of in on at by as or is be".split(
    " ",
  ),
);

export function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
      .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w)),
  );
}

export function keywordOverlap(claim: Pick<FlatClaim, "text" | "skills">, roleWords: Set<string>): number {
  let n = 0;
  for (const w of keywords(`${claim.text} ${claim.skills.join(" ")}`)) if (roleWords.has(w)) n++;
  return n;
}

/** Fallback for (b): the longest quantified claim (ties → the more recent). */
export function longestQuantified(claims: readonly FlatClaim[]): FlatClaim | null {
  return claims.filter((c) => c.quantified).reduce<FlatClaim | null>((best, c) => (!best || c.text.length > best.text.length ? c : best), null);
}

/** Fallback for (c): the claim with the most keyword overlap with the role (ties → the more recent). */
export function closestByKeywords(claims: readonly FlatClaim[], role: RoleInfo): FlatClaim | null {
  const roleWords = keywords(`${role.title} ${role.summary} ${role.spec_md}`);
  let best: FlatClaim | null = null;
  let bestScore = -1;
  for (const c of claims) {
    const s = keywordOverlap(c, roleWords);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}

/** Options ranked by JEV probability (desc), the chosen option first. */
function rankByProbability(choice: string, probabilities: Record<string, number>, ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => {
    if (a === choice) return -1;
    if (b === choice) return 1;
    return (probabilities[b] ?? 0) - (probabilities[a] ?? 0);
  });
}

const optionText = (c: FlatClaim) => (c.text.length > 300 ? `${c.text.slice(0, 299)}…` : c.text);

export async function buildPlan(input: { cv: ParsedCv | null; cvId: string | null; role: RoleInfo }): Promise<InterviewPlan> {
  const { role } = input;
  const all = flattenClaims(input.cv);
  const chosen: PlanClaim[] = [];
  const used = new Set<string>();
  const take = (c: FlatClaim, why: PlanClaim["why"]) => {
    used.add(c.id);
    chosen.push({ id: c.id, text: c.text, kind: "claim", why, roleTitle: c.roleTitle, employer: c.employer });
  };

  // (a) most recent role's first claim.
  if (all.length) take(all[0], "recent_role");

  // (b) and (c) in one JEV call.
  const quantified = all.filter((c) => c.quantified && !used.has(c.id));
  const others = all.filter((c) => !used.has(c.id));
  const questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> = {};
  if (quantified.length >= 2) {
    questions.impressive_claim = {
      type: "choice",
      instructions:
        "Which of these CV claims describes the most impressive, concrete, measurable achievement (scale of the result, not wording)?",
      criteria: Object.fromEntries(quantified.map((c) => [c.id, optionText(c)])),
    };
  }
  if (others.length >= 2) {
    questions.closest_claim = {
      type: "choice",
      instructions: "Which of these CV claims is closest to the day-to-day work described in the role spec in the state?",
      criteria: Object.fromEntries(others.map((c) => [c.id, optionText(c)])),
    };
  }

  const selection: PlanSelection = { via: "none", model: null, ms: null, impressive: null, closest: null };
  const jev = Object.keys(questions).length
    ? await systemOne(
        {
          task: "Choose which CV claims a structured screening interview should verify.",
          role: { title: role.title, summary: role.summary, spec: role.spec_md },
        },
        questions,
      )
    : null;
  if (Object.keys(questions).length) selection.via = jev ? "jev" : "fallback";
  if (jev) {
    selection.model = jev.model;
    selection.ms = jev.ms;
  }

  // (b)
  if (quantified.length === 1) take(quantified[0], "impressive_quantified");
  else if (quantified.length >= 2) {
    const ans = jev?.answers.impressive_claim;
    let pick: FlatClaim | null = null;
    if (ans) {
      selection.impressive = { choice: ans.choice, probabilities: ans.probabilities };
      const ranked = rankByProbability(ans.choice, ans.probabilities, quantified.map((c) => c.id));
      pick = quantified.find((c) => c.id === ranked[0]) ?? null;
    }
    pick ??= longestQuantified(quantified);
    if (pick) take(pick, "impressive_quantified");
  }

  // (c)
  const remaining = all.filter((c) => !used.has(c.id));
  if (remaining.length) {
    const ans = jev?.answers.closest_claim;
    let pick: FlatClaim | null = null;
    if (ans) {
      selection.closest = { choice: ans.choice, probabilities: ans.probabilities };
      const ranked = rankByProbability(ans.choice, ans.probabilities, others.map((c) => c.id));
      const id = ranked.find((x) => !used.has(x));
      pick = remaining.find((c) => c.id === id) ?? null;
    }
    pick ??= closestByKeywords(remaining, role);
    if (pick) take(pick, "closest_to_role");
  }

  // Fill from remaining claims (recency order).
  for (const c of all) {
    if (chosen.length >= CLAIMS_PER_INTERVIEW) break;
    if (!used.has(c.id)) take(c, "filler");
  }

  // Fewer than 3 claims: role titles, then generic topics.
  if (chosen.length < CLAIMS_PER_INTERVIEW && input.cv) {
    let r = 1;
    for (const role of rolesByRecency(input.cv.roles)) {
      if (chosen.length >= CLAIMS_PER_INTERVIEW) break;
      if (!role.title && !role.employer) continue;
      chosen.push({
        id: `r${r++}`,
        text: [role.title, role.employer].filter(Boolean).join(" at "),
        kind: "role",
        why: "role_title",
        roleTitle: role.title,
        employer: role.employer,
      });
    }
  }
  for (let g = 0; chosen.length < CLAIMS_PER_INTERVIEW; g++) {
    chosen.push({ id: `g${g + 1}`, text: GENERIC_TOPICS[g], kind: "generic", why: "generic", roleTitle: null, employer: null });
  }

  const claims = chosen.slice(0, CLAIMS_PER_INTERVIEW);
  const qs: Omit<PlanQuestion, "no">[] = [
    { step: "warmup", claimId: null, text: WARMUP_QUESTION },
    ...claims.map((c) => ({ step: "claim" as const, claimId: c.id, text: starQuestion(c) })),
    { step: "situational", claimId: null, text: situationalQuestion(role.slug) },
    { step: "logistics", claimId: null, text: logisticsQuestion(role) },
  ];

  return {
    v: 1,
    cvId: input.cvId,
    role: { slug: role.slug, title: role.title },
    claims,
    questions: qs.map((q, i) => ({ ...q, no: i + 1 })),
    probes: [...PROBES],
    selection,
  };
}
