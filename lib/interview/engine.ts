import { introMessage, MAX_PROBES_PER_CLAIM, OFF_SCRIPT_REPLY, ROLE_QUESTION_REPLY } from "./script";
import type { CurrentQuestion, InterviewPlan, OutMessage, ProbeDef, ProbeKey, Progress, TurnDecision } from "./types";

/**
 * The deterministic script engine. Pure: given the plan, the cursor and a decision about the
 * candidate's latest message, it returns the next cursor and the interviewer's next message(s).
 * It never evaluates or praises an answer; it only moves through fixed questions.
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
    meta: current.step === "probe" ? { probe_key: current.probeKey, question_no: current.questionNo } : { question_no: current.questionNo, total },
  };
}

function withIdx(messages: OutMessage[], start: number): OutMessage[] {
  return messages.map((m, i) => ({ ...m, meta: { ...m.meta, idx: start + i } }));
}

/** Opening: intro + question 1. */
export function openScript(plan: InterviewPlan): { progress: Progress; messages: OutMessage[] } {
  const current = questionAt(plan, 0);
  const messages = withIdx(
    [
      { step: "intro", claimId: null, content: introMessage(plan.role.title), meta: {} },
      questionMessage(current, plan.questions.length),
    ],
    0,
  );
  return {
    progress: { v: 1, qIdx: 0, probesAsked: [], current, turn: 0, msgCount: messages.length, done: false },
    messages,
  };
}

/** Probes not yet used on the current claim, in doc order. */
export function unusedProbes(plan: InterviewPlan, progress: Progress): ProbeDef[] {
  return plan.probes.filter((p) => !progress.probesAsked.includes(p.key));
}

/** A probe may follow answers to a claim question or a probe, up to 2 per claim. */
export function canProbe(plan: InterviewPlan, progress: Progress): boolean {
  if (progress.done) return false;
  if (progress.current.step !== "claim" && progress.current.step !== "probe") return false;
  return progress.probesAsked.length < MAX_PROBES_PER_CLAIM && unusedProbes(plan, progress).length > 0;
}

export interface TurnResult {
  progress: Progress;
  /** Interviewer messages to store after the candidate's message (idx already assigned). */
  messages: OutMessage[];
  /** True when the script is finished (the server then ends the session). */
  done: boolean;
  /** Order index for the candidate's own message. */
  candidateIdx: number;
}

/**
 * Applies one candidate message. Off-script messages (instruction changes, asking to be graded,
 * questions about the role) get a fixed reply and the current question again; the cursor
 * does not move. Answers move to a probe (if one was chosen and allowed) or the next question.
 */
export function applyTurn(plan: InterviewPlan, progress: Progress, decision: TurnDecision): TurnResult {
  if (progress.done) throw new Error("interview_script_finished");
  const candidateIdx = progress.msgCount;
  const total = plan.questions.length;
  const next = (p: Omit<Progress, "turn" | "msgCount">, out: OutMessage[]): TurnResult => {
    const messages = withIdx(out, candidateIdx + 1);
    return {
      progress: { ...p, turn: progress.turn + 1, msgCount: candidateIdx + 1 + messages.length },
      messages,
      done: p.done,
      candidateIdx,
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

  if (decision.probeKey && canProbe(plan, progress)) {
    const probe = unusedProbes(plan, progress).find((p) => p.key === decision.probeKey);
    if (probe) {
      const current: CurrentQuestion = {
        step: "probe",
        claimId: progress.current.claimId,
        text: probe.text,
        questionNo: progress.current.questionNo,
        probeKey: probe.key as ProbeKey,
      };
      return next({ ...progress, probesAsked: [...progress.probesAsked, probe.key], current }, [questionMessage(current, total)]);
    }
  }

  const qIdx = progress.qIdx + 1;
  if (qIdx >= plan.questions.length) {
    return next({ ...progress, qIdx: plan.questions.length, probesAsked: [], done: true }, []);
  }
  const current = questionAt(plan, qIdx);
  return next({ ...progress, qIdx, probesAsked: [], current, done: false }, [questionMessage(current, total)]);
}

/** UI label for an interviewer message. */
export function labelFor(step: string | null, meta: Record<string, unknown> | null, total: number): string | null {
  const no = typeof meta?.question_no === "number" ? meta.question_no : null;
  if (step === "probe") return "Follow-up";
  if (step && ["warmup", "claim", "situational", "logistics"].includes(step) && no) return `Question ${no} of ${total}`;
  return null;
}
