import { rands } from "@/lib/format";
import type { FollowupTarget, PlanClaim, ProbeDef } from "./types";

/**
 * Interview wording (docs/05 Part A, v2: a spoken, adaptive conversation about the CV).
 * The frame is the same for everyone: the same competencies, topic-selection rules, time and
 * rubric. Opening questions per topic are templated; follow-ups are written by an LLM from
 * the candidate's own answer (lib/server/interview), validated, and fall back to these
 * templates. The interviewer never evaluates or praises an answer.
 */

/** Topics probed per interview (roles, claims, an unevidenced skill, a CV consistency check). */
export const MAX_TOPICS = 6;
export const MIN_TOPICS = 3;
/** Roles that ended within this many years each get a topic (most recent first). */
export const RECENT_ROLE_YEARS = 5;
export const MAX_RECENT_ROLES = 3;
/** Follow-ups per topic before moving on, even if the answer is still thin. */
export const MAX_FOLLOWUPS_PER_TOPIC = 4;
/** Kept for older imports: the follow-up cap per topic. */
export const MAX_PROBES_PER_CLAIM = MAX_FOLLOWUPS_PER_TOPIC;

/** Time rules (the hard limit is 35 min, set by the DB). */
export const TARGET_MINUTES = "25–30";
export const HARD_LIMIT_MINUTES = 35;
/** Below this much time left, remaining topics are skipped and the situational question comes next. */
export const SKIP_TO_SITUATIONAL_MS = 7 * 60_000;
/** Below this, go straight to the logistics question. */
export const SKIP_TO_LOGISTICS_MS = 3 * 60_000;
/** No new follow-ups with less than this left. */
export const NO_FOLLOWUP_MS = 5 * 60_000;

/** Follow-ups on the opening question before moving to the CV topics. */
export const MAX_FOLLOWUPS_OPENER = 2;

/** The first question: why the candidate fits this role, in their own words. */
export function openingQuestion(roleTitle: string): string {
  return `Let's start with the big picture. What in your experience makes you a strong fit for the ${roleTitle} role? Tell me about the work you've done that you think qualifies you, and the one or two examples you'd point to first.`;
}

/** Template follow-ups per target (fallback when the LLM follow-up is unavailable or invalid). */
export const PROBES: readonly ProbeDef[] = [
  { key: "specifics", text: "Can you make that concrete: which tools, numbers or dates were involved, and what exactly did you do?" },
  { key: "ownership", text: "Which parts of that did you personally do, and which parts did other people do?" },
  { key: "failure", text: "What went wrong along the way, and how did you find out?" },
  { key: "tradeoff", text: "What was the hardest decision there, and what option did you reject?" },
  { key: "consistency", text: "How does that fit with the dates and roles on your CV?" },
  { key: "ai_use", text: "Which parts did AI tools do, and how did you check their output?" },
];

export const FOLLOWUP_TARGETS: readonly FollowupTarget[] = PROBES.map((p) => p.key);

export function templateFollowup(target: FollowupTarget): string {
  return PROBES.find((p) => p.key === target)?.text ?? PROBES[0].text;
}

export const SITUATIONAL: Readonly<Record<string, string>> = {
  "business-analyst":
    "A client's ops head says 'just put all our leads on WhatsApp.' You have a spreadsheet of 5,000 customer lines with no phone numbers on most rows. What do you do in your first week?",
  "software-engineer":
    "You inherit a Next.js + Supabase app a colleague built with an AI tool in two days. The client goes live Monday. What do you check first, in order, and why?",
};
const SITUATIONAL_FALLBACK =
  "You join a client project where the data is messy and the go-live date is fixed. What do you do in your first week, in order, and why?";

export function situationalQuestion(roleSlug: string): string {
  return SITUATIONAL[roleSlug] ?? SITUATIONAL_FALLBACK;
}

export function salaryBand(min: number, max: number): string {
  return min === max ? rands(min) : `${rands(min)}–${rands(max)}`;
}

export function logisticsQuestion(role: { salary_min: number; salary_max: number; location_note?: string | null }): string {
  const location = role.location_note?.trim();
  return [
    `This role pays ${salaryBand(role.salary_min, role.salary_max)} a month plus year-end profit share.`,
    location ? (/[.!?]$/.test(location) ? location : `${location}.`) : null,
    "What makes this the right next move for you, and when could you start?",
  ]
    .filter(Boolean)
    .join(" ");
}

const STAR_TAIL = "Walk me through what you personally did, which tools you used, and how you measured the result.";

/** Claim text as it reads after "Your CV says you '…'". */
export function quoteClaim(text: string, max = 280): string {
  let t = text.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").replace(/\s+/g, " ").replace(/[.;,\s]+$/, "");
  // "Built X" → "built X", but keep acronyms/proper starts like "SQL" or "AWS".
  if (/^[A-Z][a-z]/.test(t)) t = t[0].toLowerCase() + t.slice(1);
  if (t.length > max) t = `${t.slice(0, max - 1).trimEnd()}…`;
  return t;
}

export function starQuestion(claim: PlanClaim): string {
  const need = claim.requirement ? `This role involves ${claim.requirement.text}. ` : "";
  if (claim.kind === "gap") {
    return `This role involves ${claim.text}. That doesn't come through clearly on your CV. What's the closest you've done to it? Pick one example and walk me through what you personally did, which tools you used, and how it turned out.`;
  }
  if (claim.kind === "claim") return `${need}Your CV says you '${quoteClaim(claim.text)}'. ${STAR_TAIL}`;
  if (claim.kind === "role") {
    const where = [claim.roleTitle ? `as ${claim.roleTitle}` : null, claim.employer ? `at ${claim.employer}` : null]
      .filter(Boolean)
      .join(" ");
    return `Your CV lists your role ${where}. Pick one piece of work from that role. ${STAR_TAIL}`;
  }
  if (claim.kind === "skill") {
    return `Your CV lists ${claim.text} as a skill. Tell me about the last time you used it: what you built or analysed with it, and one problem you had to solve along the way.`;
  }
  if (claim.kind === "consistency") {
    return `${claim.text} Can you walk me through that period: what you were doing, and how the roles fit together?`;
  }
  return `Tell me about ${claim.text}. ${STAR_TAIL}`;
}

/** Stand-ins when a CV has too few claims and roles. */
export const GENERIC_TOPICS = [
  "a recent piece of work you are proud of",
  "a problem you solved using data or software",
  "a time you had to learn a new tool quickly to deliver something",
] as const;

export function introMessage(roleTitle: string, mode: "voice" | "typed" = "voice"): string {
  return [
    `Hi, I'm the Chase Agents screening interviewer for the ${roleTitle} role.`,
    `This is a conversation about how your experience fits this role. It takes about ${TARGET_MINUTES} minutes, with a hard limit of ${HARD_LIMIT_MINUTES}.`,
    "I'll ask about the parts of your CV that matter most for the job and follow up on your answers, so please be specific: say what you personally did, and name the tools, numbers and decisions involved.",
    mode === "voice"
      ? "Answer out loud: press Record, speak, then press Stop and send. Each answer can be up to 3 minutes."
      : "You have been set up to type your answers. Paste is turned off.",
    "Please stay on this page: leaving it once pauses the interview, and leaving it a second time locks it until our team reopens it. Let's start.",
  ].join(" ");
}

export const OFF_SCRIPT_REPLY = "I can't help with that, but let's carry on.";
export const ROLE_QUESTION_REPLY = "Good question, the team will follow up on that.";

export const CLOSING_COMPLETED =
  "Thank you, that was the last question. The interview is complete and your answers have been saved. You'll find your next step on your results page.";
export const CLOSING_TIMEOUT =
  "Time is up, so the interview has ended. Everything you sent before the deadline has been saved. You'll find your next step on your results page.";
export const CLOSING_ENDED =
  "You've ended the interview. Everything you answered has been saved and will be assessed as it is. You'll find your next step on your results page.";
