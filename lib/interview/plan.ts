import { systemOne } from "@/lib/jev";
import type { ParsedCv } from "@/lib/cv/schema";
import {
  GENERIC_TOPICS,
  MAX_RECENT_ROLES,
  MAX_TOPICS,
  MIN_TOPICS,
  RECENT_ROLE_YEARS,
  logisticsQuestion,
  PROBES,
  situationalQuestion,
  starQuestion,
  WARMUP_QUESTION,
} from "./script";
import type { InterviewPlan, PlanClaim, PlanQuestion, PlanSelection } from "./types";

/**
 * Builds the per-candidate conversation plan from the parsed CV (docs/05 Part A, v2). Topics:
 *   1. every role current or ended within 5 years (up to 3), via its strongest claim,
 *   2. the most impressive quantified claim (JEV choice; fallback: longest quantified claim),
 *   3. the claim closest to the role spec (JEV choice; fallback: keyword overlap),
 *   4. a CV consistency question when dates overlap, leave a gap or run backwards (deterministic),
 *   5. one skill the CV lists but never evidences (JEV choice; fallback: keyword overlap).
 * Capped at MAX_TOPICS by priority, at least MIN_TOPICS (filled from other claims, role titles,
 * generic topics). JEV only picks between things the candidate wrote; it never writes questions.
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

/** Year-month as a sortable month index (year*12 + month-1); "present" = far future. */
export function monthIndex(v: string | null): number | null {
  const k = dateKey(v);
  if (!k) return null;
  const [y, m] = k.split("-").map(Number);
  return y * 12 + (m - 1);
}

function fmtMonth(v: string | null): string {
  if (!v) return "?";
  if (PRESENT.test(v.trim())) return "present";
  return v;
}

/**
 * Deterministic CV consistency checks worth asking about (never a judgement): roles that
 * overlap by 3+ months, a gap of 6+ months between roles, and a role that ends before it
 * starts. Returns neutral sentences, most notable first.
 */
export function consistencyIssues(cv: ParsedCv | null): string[] {
  if (!cv) return [];
  const label = (r: CvRole) => [r.title, r.employer].filter(Boolean).join(" at ") || "a role";
  const roles = cv.roles
    .map((r) => ({ r, s: monthIndex(r.start), e: monthIndex(r.end) }))
    .filter((x) => x.s !== null);
  const issues: string[] = [];
  for (const x of roles) {
    if (x.e !== null && x.e < x.s!) issues.push(`Your CV lists ${label(x.r)} as ending (${fmtMonth(x.r.end)}) before it started (${fmtMonth(x.r.start)}).`);
  }
  const sorted = [...roles].sort((a, b) => a.s! - b.s!);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      const aEnd = a.e ?? a.s!;
      const overlap = Math.min(aEnd, b.e ?? b.s!) - b.s!;
      if (overlap >= 3) {
        issues.push(
          `Your CV shows two roles at the same time: ${label(a.r)} (${fmtMonth(a.r.start)} to ${fmtMonth(a.r.end)}) and ${label(b.r)} (${fmtMonth(b.r.start)} to ${fmtMonth(b.r.end)}).`,
        );
      }
    }
    const next = sorted[i + 1];
    const end = sorted[i].e;
    if (next && end !== null && end < 9999 * 12 && next.s! - end >= 6) {
      issues.push(
        `Your CV shows a gap between ${label(sorted[i].r)} (ended ${fmtMonth(sorted[i].r.end)}) and ${label(next.r)} (started ${fmtMonth(next.r.start)}).`,
      );
    }
  }
  return issues;
}

/** Skills listed on the CV that no role claim mentions or tags. */
export function unevidencedSkills(cv: ParsedCv | null): string[] {
  if (!cv) return [];
  const evidence = cv.roles
    .flatMap((r) => r.claims.flatMap((c) => [c.text, ...c.skills]))
    .join(" \n ")
    .toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of cv.skills) {
    const skill = raw.trim();
    const key = skill.toLowerCase();
    if (skill.length < 2 || skill.length > 60 || seen.has(key)) continue;
    seen.add(key);
    const re = new RegExp(`(^|[^a-z0-9+#])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9+#]|$)`, "i");
    if (!re.test(evidence)) out.push(skill);
  }
  return out;
}

/** Roles that are current or ended within RECENT_ROLE_YEARS of `now`, most recent first. */
export function recentRoles(cv: ParsedCv | null, now = new Date()): CvRole[] {
  if (!cv) return [];
  const cutoff = (now.getUTCFullYear() - RECENT_ROLE_YEARS) * 12 + now.getUTCMonth();
  return rolesByRecency(cv.roles).filter((r) => {
    const e = monthIndex(r.end) ?? monthIndex(r.start);
    return e !== null && e >= cutoff;
  });
}

/** The claim that best represents a role: the longest quantified one, else the first. */
function bestClaimOf(role: CvRole, all: readonly FlatClaim[], used: Set<string>): FlatClaim | null {
  const own = all.filter((c) => !used.has(c.id) && role.claims.some((rc) => rc.id === c.id));
  return longestQuantified(own) ?? own[0] ?? null;
}

type TopicPick = { claim: PlanClaim; priority: number; order: number };

export async function buildPlan(input: { cv: ParsedCv | null; cvId: string | null; role: RoleInfo; now?: Date }): Promise<InterviewPlan> {
  const { role } = input;
  const all = flattenClaims(input.cv);
  const used = new Set<string>();
  const picks: TopicPick[] = [];
  let order = 0;
  const takeClaim = (c: FlatClaim, why: PlanClaim["why"], priority: number) => {
    used.add(c.id);
    picks.push({ claim: { id: c.id, text: c.text, kind: "claim", why, roleTitle: c.roleTitle, employer: c.employer }, priority, order: order++ });
  };

  // 1. Every recent role (up to MAX_RECENT_ROLES), represented by its strongest claim or the role itself.
  const recent = recentRoles(input.cv, input.now).slice(0, MAX_RECENT_ROLES);
  const ordered = input.cv ? rolesByRecency(input.cv.roles) : [];
  recent.forEach((r, i) => {
    const c = bestClaimOf(r, all, used);
    // The most recent role is always kept; older recent roles are dropped first when over the cap.
    const priority = i === 0 ? 0 : 5 + i;
    if (c) takeClaim(c, "recent_role", priority);
    else if (r.title || r.employer) {
      picks.push({
        claim: { id: `r${ordered.indexOf(r) + 1}`, text: [r.title, r.employer].filter(Boolean).join(" at "), kind: "role", why: "role_title", roleTitle: r.title, employer: r.employer },
        priority,
        order: order++,
      });
    }
  });
  if (!recent.length && all.length) takeClaim(all[0], "recent_role", 0);

  // 2-4. One JEV call: most impressive quantified claim, closest to the role, most important unevidenced skill.
  const quantified = all.filter((c) => c.quantified && !used.has(c.id));
  const others = all.filter((c) => !used.has(c.id));
  const skills = unevidencedSkills(input.cv).slice(0, 40);
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
  if (skills.length >= 2) {
    questions.key_skill = {
      type: "choice",
      instructions: "Which of these skills matters most for the role spec in the state?",
      criteria: Object.fromEntries(skills.map((sk, i) => [`s${i}`, sk])),
    };
  }

  const selection: PlanSelection = { via: "none", model: null, ms: null, impressive: null, closest: null };
  const jev = Object.keys(questions).length
    ? await systemOne(
        {
          task: "Choose which parts of a CV a structured screening conversation should verify.",
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

  // 2. Most impressive quantified claim.
  if (quantified.length === 1) takeClaim(quantified[0], "impressive_quantified", 1);
  else if (quantified.length >= 2) {
    const ans = jev?.answers.impressive_claim;
    let pick: FlatClaim | null = null;
    if (ans) {
      selection.impressive = { choice: ans.choice, probabilities: ans.probabilities };
      const ranked = rankByProbability(ans.choice, ans.probabilities, quantified.map((c) => c.id));
      pick = quantified.find((c) => c.id === ranked[0]) ?? null;
    }
    pick ??= longestQuantified(quantified);
    if (pick) takeClaim(pick, "impressive_quantified", 1);
  }

  // 3. Claim closest to the role.
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
    if (pick) takeClaim(pick, "closest_to_role", 2);
  }

  // 4. A CV consistency question (deterministic), then 5. an unevidenced skill.
  const issue = consistencyIssues(input.cv)[0];
  if (issue) {
    picks.push({ claim: { id: "k1", text: issue, kind: "consistency", why: "cv_consistency", roleTitle: null, employer: null }, priority: 3, order: 1000 });
  }
  if (skills.length) {
    const ans = jev?.answers.key_skill;
    let skill = ans ? skills[Number(ans.choice.replace(/^s/, ""))] : undefined;
    if (!skill) {
      const roleWords = keywords(`${role.title} ${role.summary} ${role.spec_md}`);
      skill = [...skills].sort((a, b) => keywordOverlap({ text: b, skills: [] }, roleWords) - keywordOverlap({ text: a, skills: [] }, roleWords))[0];
    }
    if (skill) {
      picks.push({ claim: { id: "s1", text: skill, kind: "skill", why: "skill_unevidenced", roleTitle: null, employer: null }, priority: 4, order: 999 });
    }
  }

  // Keep the highest-priority topics up to the cap, then present them in a natural order.
  let chosen = [...picks].sort((a, b) => a.priority - b.priority || a.order - b.order).slice(0, MAX_TOPICS);

  // Too few topics: fill from remaining claims, role titles, then generic topics.
  const fill = (claim: PlanClaim) => chosen.push({ claim, priority: 9, order: order++ });
  for (const c of all) {
    if (chosen.length >= MIN_TOPICS) break;
    if (!used.has(c.id)) {
      used.add(c.id);
      fill({ id: c.id, text: c.text, kind: "claim", why: "filler", roleTitle: c.roleTitle, employer: c.employer });
    }
  }
  if (chosen.length < MIN_TOPICS && input.cv) {
    // r<n> is the role's position in recency order, the same id the recent-role step uses.
    for (const [i, ro] of rolesByRecency(input.cv.roles).entries()) {
      if (chosen.length >= MIN_TOPICS) break;
      if (!ro.title && !ro.employer) continue;
      const id = `r${i + 1}`;
      if (chosen.some((p) => p.claim.id === id)) continue;
      fill({ id, text: [ro.title, ro.employer].filter(Boolean).join(" at "), kind: "role", why: "role_title", roleTitle: ro.title, employer: ro.employer });
    }
  }
  for (let g = 0; chosen.length < MIN_TOPICS && g < GENERIC_TOPICS.length; g++) {
    fill({ id: `g${g + 1}`, text: GENERIC_TOPICS[g], kind: "generic", why: "generic", roleTitle: null, employer: null });
  }
  chosen = chosen.sort((a, b) => a.order - b.order);

  const claims = chosen.map((p) => p.claim);
  const qs: Omit<PlanQuestion, "no">[] = [
    { step: "warmup", claimId: null, text: WARMUP_QUESTION },
    ...claims.map((c) => ({ step: "claim" as const, claimId: c.id, text: starQuestion(c) })),
    { step: "situational", claimId: null, text: situationalQuestion(role.slug) },
    { step: "logistics", claimId: null, text: logisticsQuestion(role) },
  ];

  return {
    v: 2,
    cvId: input.cvId,
    role: { slug: role.slug, title: role.title },
    claims,
    questions: qs.map((q, i) => ({ ...q, no: i + 1 })),
    probes: [...PROBES],
    selection,
  };
}
