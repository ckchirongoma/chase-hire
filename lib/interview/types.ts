/**
 * Types shared by the interview engine, the server module and the candidate UI.
 * No runtime imports here, so client components can import it safely.
 */

/** What a follow-up question tries to draw out of an answer. */
export type FollowupTarget = "specifics" | "ownership" | "failure" | "tradeoff" | "consistency" | "ai_use";
/** Kept for older call sites: a follow-up is identified by its target. */
export type ProbeKey = FollowupTarget;

/** Main (counted) question steps. */
export type QuestionStep = "warmup" | "claim" | "situational" | "logistics";
/** Every interviewer message step stored in interview_messages.step. */
export type MessageStep = QuestionStep | "probe" | "intro" | "redirect" | "close";

export type ClaimReason =
  | "recent_role"
  | "impressive_quantified"
  | "closest_to_role"
  | "filler"
  | "role_title"
  | "generic"
  | "skill_unevidenced"
  | "cv_consistency"
  | "role_requirement"
  | "requirement_gap";

export interface PlanClaim {
  /** CV claim id (c1…), or r1… for a role-title stand-in, or g1… for a generic stand-in. */
  id: string;
  text: string;
  kind: "claim" | "role" | "generic" | "skill" | "consistency" | "gap";
  why: ClaimReason;
  roleTitle: string | null;
  employer: string | null;
  /** The part of the job this topic is evidence for (lib/interview/requirements.ts). */
  requirement?: { key: string; text: string };
}

export interface PlanQuestion {
  /** 1-based question number out of the plan's total. */
  no: number;
  step: QuestionStep;
  claimId: string | null;
  text: string;
}

export interface ProbeDef {
  key: FollowupTarget;
  text: string;
}

export interface PlanSelection {
  via: "jev" | "fallback" | "none";
  model: string | null;
  ms: number | null;
  impressive: { choice: string | null; probabilities: Record<string, number> } | null;
  closest: { choice: string | null; probabilities: Record<string, number> } | null;
  /** JEV's pick per role requirement ("none" = the CV shows nothing for it). */
  requirements?: Record<string, { choice: string | null; probabilities: Record<string, number> }>;
}

export interface InterviewPlan {
  v: 2;
  cvId: string | null;
  role: { slug: string; title: string };
  claims: PlanClaim[];
  questions: PlanQuestion[];
  /** Template follow-ups, one per target (used when the LLM follow-up is unavailable). */
  probes: ProbeDef[];
  selection: PlanSelection;
}

export interface CurrentQuestion {
  step: QuestionStep | "probe";
  claimId: string | null;
  text: string;
  /** Number of the main question this belongs to (a probe keeps its claim question's number). */
  questionNo: number;
  probeKey?: FollowupTarget;
}

/** Server-side cursor stored in interview_sessions.progress. */
export interface Progress {
  v: 2;
  /** Index into plan.questions of the current main question. */
  qIdx: number;
  /** Targets of the follow-ups already asked on the current topic (one entry per follow-up). */
  probesAsked: FollowupTarget[];
  current: CurrentQuestion;
  /** Candidate messages accepted so far (optimistic-lock token). */
  turn: number;
  /** Messages stored so far; the next message gets this as its order index. */
  msgCount: number;
  done: boolean;
}

/** What the server decided about one candidate message. */
export type TurnDecision =
  | { kind: "answer"; followup: { text: string; target: FollowupTarget; via: "llm" | "template" } | null }
  | { kind: "off_script" }
  | { kind: "role_question" };

export interface OutMessage {
  step: MessageStep;
  claimId: string | null;
  content: string;
  meta: Record<string, unknown>;
}

/** Candidate-safe view returned by the API. */
export interface InterviewMessageView {
  id: string;
  role: "interviewer" | "candidate";
  content: string;
  step: string | null;
  label: string | null;
  at: string;
}

export type InterviewView =
  | { status: "none" }
  | {
      status: "active" | "done";
      sessionId: string;
      messages: InterviewMessageView[];
      deadlineAt: string;
      serverNow: string;
      done: boolean;
      endReason: "completed" | "timeout" | "ended_by_candidate" | null;
      /** The question currently awaiting an answer (null when done). */
      current: { label: string; text: string } | null;
      totalQuestions: number;
      /**
       * Turn token: the client sends it back with its answer, and the server refuses an answer
       * for any other turn (a re-send, a second tab) with 409 instead of booking it against a
       * question the candidate never saw.
       */
      turn: number;
      /** The answer for this turn is stored and the next question is still being prepared. */
      pending: boolean;
      /** Candidate-facing reason answers are not accepted right now (admin hold, closed application). */
      notice: string | null;
      /** Set on a message response: whether the answer just sent was stored ("late" = after the deadline). */
      lastAnswer?: "saved" | "late";
      /** "voice" (default): answers are spoken; "typed": an admin-approved accommodation. */
      answerMode: "voice" | "typed";
      /** Locked after leaving the page twice; an admin must reopen it. */
      locked: boolean;
      /** Times the candidate has left the page (the first one pauses, the second locks). */
      tabLeaves: number;
    };
