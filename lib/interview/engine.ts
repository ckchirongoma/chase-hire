import {
  introMessage,
  MAX_FOLLOWUPS_OPENER,
  MAX_FOLLOWUPS_PER_TOPIC,
  NO_FOLLOWUP_MS,
  OFF_SCRIPT_REPLY,
  ROLE_QUESTION_REPLY,
  SKIP_TO_LOGISTICS_MS,
  SKIP_TO_SITUATIONAL_MS,
} from "./script";
import type { CurrentQuestion, FollowupTarget, InterviewPlan, OutMessage, ProbeDef, Progress, TurnDecision } from "./types";

/**
 * The conversation engine. Pure: given the plan, the cursor and a decision about the
 * candidate's latest message, it returns the next cursor and the interviewer's next message(s).
 * Opening questions per topic are fixed by the plan; follow-up text is supplied in the decision
 * (an LLM-written, validated follow-up or a template). It never evaluates or praises an answer.
 */

function questionAt(plan: InterviewPlan, qIdx: number): CurrentQuestion {
  const q = plan.questions[qIdx];
  return { step: q.step, claimId: q.claimId, text: q.text, questionNo: q.no };
}

function questionMessage(current: CurrentQuestion, total: number): OutMessage {
  return {
    step: current.step,
    claimId: current.claimId,
    content: current.text,
    meta:
      current.step === "probe"
        ? { probe_key: current.probeKey, question_no: current.questionNo }
        : { question_no: current.questionNo, total },
  };
}

function withIdx(messages: OutMessage[], start: number): OutMessage[] {
  return messages.map((m, i) => ({ ...m, meta: { ...m.meta, idx: start + i } }));
}

/** Opening: intro + question 1. */
export function openScript(plan: InterviewPlan, mode: "voice" | "typed" = "voice"): { progress: Progress; messages: OutMessage[] } {
  const current = questionAt(plan, 0);
  const messages = withIdx(
    [
      { step: "intro", claimId: null, content: introMessage(plan.role.title, mode), meta: {} },
      questionMessage(current, plan.questions.length),
    ],
    0,
  );
  return {
    progress: { v: 2, qIdx: 0, probesAsked: [], current, turn: 0, msgCount: messages.length, done: false },
    messages,
  };
}

/** Follow-up targets not yet used on the current topic, in template order. */
export function unusedProbes(plan: InterviewPlan, progress: Progress): ProbeDef[] {
  return plan.probes.filter((p) => !progress.probesAsked.includes(p.key));
}

/**
 * A follow-up may come after an answer to the opening question, a topic question or a follow-up,
 * up to MAX_FOLLOWUPS_OPENER on the opening question and MAX_FOLLOWUPS_PER_TOPIC per topic, and
 * only while enough time is left.
 */
export function canProbe(plan: InterviewPlan, progress: Progress, remainingMs?: number): boolean {
  if (progress.done) return false;
  const main = plan.questions[progress.qIdx]?.step;
  if (main !== "claim" && main !== "warmup") return false;
  if (progress.current.step !== main && progress.current.step !== "probe") return false;
  if (remainingMs !== undefined && remainingMs < NO_FOLLOWUP_MS) return false;
  return progress.probesAsked.length < (main === "warmup" ? MAX_FOLLOWUPS_OPENER : MAX_FOLLOWUPS_PER_TOPIC);
}

/**
 * The next main question index after `qIdx`, skipping ahead when time is short: below
 * SKIP_TO_SITUATIONAL_MS remaining topics are skipped; below SKIP_TO_LOGISTICS_MS everything but
 * the logistics question is skipped.
 */
export function nextQuestionIndex(plan: InterviewPlan, qIdx: number, remainingMs?: number): number {
  const next = qIdx + 1;
  if (next >= plan.questions.length || remainingMs === undefined) return next;
  const logistics = plan.questions.findIndex((q) => q.step === "logistics");
  const situational = plan.questions.findIndex((q) => q.step === "situational");
  if (remainingMs < SKIP_TO_LOGISTICS_MS && logistics > next) return logistics;
  if (remainingMs < SKIP_TO_SITUATIONAL_MS && plan.questions[next].step === "claim" && situational > next) return situational;
  return next;
}

export interface TurnResult {
  progress: Progress;
  /** Interviewer messages to store after the candidate's message (idx already assigned). */
  messages: OutMessage[];
  /** True when the conversation is finished (the server then ends the session). */
  done: boolean;
  /** Order index for the candidate's own message. */
  candidateIdx: number;
  /** Main questions skipped because time was short. */
  skipped: number;
}

/**
 * Applies one candidate message. Off-script messages (instruction changes, asking to be graded,
 * questions about the role) get a fixed reply and the current question again; the cursor does
 * not move. Answers move to the supplied follow-up (if allowed) or the next question.
 */
export function applyTurn(plan: InterviewPlan, progress: Progress, decision: TurnDecision, opts: { remainingMs?: number } = {}): TurnResult {
  if (progress.done) throw new Error("interview_script_finished");
  const candidateIdx = progress.msgCount;
  const total = plan.questions.length;
  const next = (p: Omit<Progress, "turn" | "msgCount">, out: OutMessage[], skipped = 0): TurnResult => {
    const messages = withIdx(out, candidateIdx + 1);
    return {
      progress: { ...p, turn: progress.turn + 1, msgCount: candidateIdx + 1 + messages.length },
      messages,
      done: p.done,
      candidateIdx,
      skipped,
    };
  };

  if (decision.kind === "off_script" || decision.kind === "role_question") {
    const reply = decision.kind === "off_script" ? OFF_SCRIPT_REPLY : ROLE_QUESTION_REPLY;
    return next({ ...progress }, [
      {
        step: "redirect",
        claimId: progress.current.claimId,
        content: `${reply}\n\n${progress.current.text}`,
        meta: { reason: decision.kind, repeats: progress.current.step, question_no: progress.current.questionNo },
      },
    ]);
  }

  if (decision.followup && canProbe(plan, progress, opts.remainingMs)) {
    const target: FollowupTarget = decision.followup.target;
    const current: CurrentQuestion = {
      step: "probe",
      claimId: progress.current.claimId,
      text: decision.followup.text,
      questionNo: progress.current.questionNo,
      probeKey: target,
    };
    const msg = questionMessage(current, total);
    return next({ ...progress, probesAsked: [...progress.probesAsked, target], current }, [
      { ...msg, meta: { ...msg.meta, followup_via: decision.followup.via } },
    ]);
  }

  const qIdx = nextQuestionIndex(plan, progress.qIdx, opts.remainingMs);
  const skipped = Math.max(0, qIdx - progress.qIdx - 1);
  if (qIdx >= plan.questions.length) {
    return next({ ...progress, qIdx: plan.questions.length, probesAsked: [], done: true }, [], skipped);
  }
  const current = questionAt(plan, qIdx);
  const msg = questionMessage(current, total);
  return next(
    { ...progress, qIdx, probesAsked: [], current, done: false },
    [skipped ? { ...msg, meta: { ...msg.meta, skipped_for_time: skipped } } : msg],
    skipped,
  );
}

/** UI label for an interviewer message. */
export function labelFor(step: string | null, meta: Record<string, unknown> | null, total: number): string | null {
  const no = typeof meta?.question_no === "number" ? meta.question_no : null;
  if (step === "probe") return "Follow-up";
  if (step && ["warmup", "claim", "situational", "logistics"].includes(step) && no) return `Question ${no} of ${total}`;
  return null;
}
