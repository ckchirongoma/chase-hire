import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { chatJson, transcribe, type TranscribeFormat } from "@/lib/ai";
import { serverEnv } from "@/lib/config";
import { ParsedCv } from "@/lib/cv/schema";
import { loadPrompt } from "@/lib/prompts";
import { sanitise, wrapUntrusted } from "@/lib/sanitise";
import { withBudget } from "@/lib/work/async";
import { criterionBlock, criterionTo100, mapLimit, RubricRow, weightedMean } from "@/lib/grading";
import { applyTurn, labelFor, openScript } from "@/lib/interview/engine";
import { classifyTurn, JEV_TURN_BUDGET_MS } from "@/lib/interview/classify";
import { FollowupOutput, resolveFollowup } from "@/lib/interview/followup";
import { requirementsFor } from "@/lib/interview/requirements";
import { buildPlan, type RoleInfo } from "@/lib/interview/plan";
import { CLOSING_COMPLETED, CLOSING_ENDED, CLOSING_TIMEOUT } from "@/lib/interview/script";
import { renderTranscript, type TranscriptMessage } from "@/lib/interview/transcript";
import type { InterviewMessageView, InterviewPlan, InterviewView, OutMessage, Progress, TurnDecision } from "@/lib/interview/types";
import {
  enqueueGrading,
  gradeCriterion,
  GradingError,
  logInjectionSignal,
  runGradingJob,
  screenSubjectForInjection,
  upsertSummary,
} from "@/lib/server/grading";

/**
 * AI CV-verification interview (docs/05 Part A). Every function takes the service-role client
 * and an already-authenticated user id, and checks that the application is theirs.
 *
 * - The DB sets started_at/deadline_at (25 min) and refuses candidate messages after
 *   deadline + 5 s; this module also ends sessions lazily once that has passed.
 * - An answer is stored FIRST (the DB timestamps it against the deadline), and only then
 *   classified (JEV, bounded wait) and the script moved on. One answer per turn: the client
 *   sends the turn token it saw, and a unique index (migration 0009) refuses a second answer
 *   for the same turn. The cursor move + interviewer reply are one transaction (interview_advance).
 * - The script is deterministic (lib/interview/engine); JEV only steers probes and off-script
 *   handling, with deterministic fallbacks.
 * - Ending the interview is the one automatic stage move: interview → quiz (in_progress).
 *   Nothing here sets advanced/rejected.
 * - Application status during an open session:
 *     in_progress / advanced → answers accepted.
 *     awaiting_review (admin hold) → answers refused with a notice; the DB clock keeps running
 *       (deadline_at is immutable). If the hold is released in time the candidate carries on;
 *       otherwise the session times out and is still graded, so the reviewer has the evidence.
 *     rejected / withdrawn / lapsed → answers refused; the session ends at its deadline and no
 *       grading is queued (an admin can still run it with POST /api/grading/run).
 *
 * Abandoned sessions (tab closed) are ended by the cron sweep in GET /api/grading/run, which
 * must be scheduled (see that route).
 */

export class InterviewError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** 409 that carries the current state, so the client can refresh without losing its draft. */
export class InterviewConflict extends InterviewError {
  constructor(
    message: string,
    public state: InterviewView,
  ) {
    super(message, 409);
  }
}

/** Runs work after the HTTP response (routes pass next/server `after`). */
export type Defer = (task: () => Promise<unknown>) => void;

export const INTERVIEW_GRACE_MS = 5000;
export const INTERVIEW_RUBRIC = { key: "interview", version: 2 } as const;
const GRADER_PROMPT = { key: "interview-grader", version: 2 } as const;
const FOLLOWUP_PROMPT = { key: "interviewer-followup", version: 2 } as const;
/** Longest the candidate waits for an LLM-written follow-up before the template is used. */
export const FOLLOWUP_BUDGET_MS = 8000;
/** Longest a spoken answer may take to transcribe before it is stored as untranscribed. */
export const TRANSCRIBE_BUDGET_MS = 45_000;
/** About 3 minutes of browser-recorded speech is well under 1 MB; this is a generous cap. */
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
export const TRANSCRIBING_PLACEHOLDER = "(transcribing your answer…)";
export const NO_SPEECH_PLACEHOLDER = "(no speech was detected in this answer)";
export const TRANSCRIPTION_FAILED_PLACEHOLDER = "(this answer could not be transcribed; our team will listen to the recording)";
/** Browser recording MIME types → transcription format + file extension. */
export const AUDIO_TYPES: Record<string, TranscribeFormat> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};
const CONCERNS_PROMPT = { key: "interview-concerns", version: 1 } as const;
const CRITERIA_CONCURRENCY = 3;
/** A stored answer whose turn was never moved on (a crashed request) is finished after this. */
export const PENDING_RECOVERY_MS = 20_000;

const OPEN_STATUSES = ["in_progress", "advanced"];
/** No grading is queued automatically when an interview for one of these ends. */
const CLOSED_STATUSES = ["rejected", "withdrawn", "lapsed"];

type SessionRow = {
  id: string;
  application_id: string;
  user_id: string;
  plan: InterviewPlan;
  progress: Progress;
  started_at: string;
  deadline_at: string;
  ended_at: string | null;
  end_reason: "completed" | "timeout" | "ended_by_candidate" | null;
  locked_at: string | null;
  tab_leaves: number;
  answer_mode: "voice" | "typed";
};
const SESSION_COLS =
  "id, application_id, user_id, plan, progress, started_at, deadline_at, ended_at, end_reason, locked_at, tab_leaves, answer_mode";

type ApplicationRow = { id: string; user_id: string; role_id: string; stage: string; status: string; interview_answer_mode: "voice" | "typed" };

export const LOCKED_NOTICE =
  "This interview is locked because you left the page twice. A person on our team will review it and can reopen it, and you'll get back the time you had left. This is not a rejection.";

/** Why answers are not accepted for this application right now (null = they are). */
function statusNotice(app: Pick<ApplicationRow, "stage" | "status">): string | null {
  if (app.stage !== "interview") return "The interview stage is closed for this application, so no more answers can be sent.";
  if (OPEN_STATUSES.includes(app.status)) return null;
  if (app.status === "awaiting_review") {
    return (
      "A person on our team is reviewing your application, so the interview is paused. This is not a rejection. " +
      "The clock keeps running; if the review finishes before your time is up, you can carry on here."
    );
  }
  if (CLOSED_STATUSES.includes(app.status)) return "This application is closed, so the interview can't continue.";
  return "The interview isn't accepting answers for this application right now.";
}

async function ownApplication(admin: SupabaseClient, userId: string, applicationId: string): Promise<ApplicationRow> {
  const { data, error } = await admin
    .from("applications")
    .select("id, user_id, role_id, stage, status, interview_answer_mode")
    .eq("id", applicationId)
    .maybeSingle<ApplicationRow>();
  if (error) throw new InterviewError(error.message, 500);
  if (!data || data.user_id !== userId) throw new InterviewError("Application not found", 404);
  return data;
}

async function sessionFor(admin: SupabaseClient, applicationId: string): Promise<SessionRow | null> {
  const { data, error } = await admin
    .from("interview_sessions")
    .select(SESSION_COLS)
    .eq("application_id", applicationId)
    .maybeSingle<SessionRow>();
  if (error) throw new InterviewError(error.message, 500);
  return data;
}

/** A locked session never expires on its own: an admin reopens it with its remaining time. */
function isExpired(s: Pick<SessionRow, "deadline_at" | "locked_at">, now = Date.now()) {
  return !s.locked_at && now > new Date(s.deadline_at).getTime() + INTERVIEW_GRACE_MS;
}

function remainingMs(s: Pick<SessionRow, "deadline_at">, now = Date.now()): number {
  return new Date(s.deadline_at).getTime() - now;
}

function messageRows(sessionId: string, messages: readonly OutMessage[]) {
  return messages.map((m) => ({
    session_id: sessionId,
    role: "interviewer" as const,
    content: m.content,
    step: m.step,
    claim_id: m.claimId,
    meta: m.meta,
  }));
}

type MessageRow = { id: string; role: "interviewer" | "candidate"; content: string; step: string | null; meta: Record<string, unknown> | null; created_at: string };

async function loadMessages(admin: SupabaseClient, sessionId: string): Promise<MessageRow[]> {
  const { data, error } = await admin
    .from("interview_messages")
    .select("id, role, content, step, meta, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (error) throw new InterviewError(error.message, 500);
  // meta.idx is the script's own order (several rows can share a created_at).
  return [...((data ?? []) as MessageRow[])].sort((a, b) => {
    const ai = typeof a.meta?.idx === "number" ? a.meta.idx : Infinity;
    const bi = typeof b.meta?.idx === "number" ? b.meta.idx : Infinity;
    return ai !== bi ? ai - bi : a.created_at.localeCompare(b.created_at);
  });
}

async function loadMessagesWithClaims(admin: SupabaseClient, sessionId: string): Promise<(MessageRow & { claim_id: string | null })[]> {
  const { data, error } = await admin
    .from("interview_messages")
    .select("id, role, content, step, claim_id, meta, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (error) throw new InterviewError(error.message, 500);
  return [...((data ?? []) as (MessageRow & { claim_id: string | null })[])].sort((a, b) => {
    const ai = typeof a.meta?.idx === "number" ? a.meta.idx : Infinity;
    const bi = typeof b.meta?.idx === "number" ? b.meta.idx : Infinity;
    return ai !== bi ? ai - bi : a.created_at.localeCompare(b.created_at);
  });
}

// ───────────────────────── Start ─────────────────────────

export async function startInterview(admin: SupabaseClient, userId: string, applicationId: string, defer?: Defer): Promise<InterviewView> {
  const app = await ownApplication(admin, userId, applicationId);
  if (await sessionFor(admin, app.id)) return getInterviewState(admin, userId, applicationId, defer);

  if (app.stage !== "interview") throw new InterviewError("The interview stage is closed for this application", 409);
  if (app.status === "awaiting_review") {
    throw new InterviewError("A person on our team is reviewing your application before the interview opens. This is not a rejection.", 403);
  }
  if (app.status !== "in_progress" && app.status !== "advanced") {
    throw new InterviewError("The interview is not available for this application", 403);
  }

  const { data: cvs } = await admin
    .from("cvs")
    .select("id, parsed")
    .eq("user_id", userId)
    .eq("status", "parsed")
    .order("created_at", { ascending: false })
    .limit(1);
  const cv = cvs?.[0];
  if (!cv) throw new InterviewError("Upload your CV before starting the interview", 403);
  const parsed = ParsedCv.safeParse(cv.parsed ?? {});

  const { data: role, error: roleErr } = await admin
    .from("roles")
    .select("slug, title, summary, spec_md, salary_min, salary_max, location_note")
    .eq("id", app.role_id)
    .single<RoleInfo>();
  if (roleErr || !role) throw new InterviewError("Role not found", 404);

  const plan = await buildPlan({ cv: parsed.success ? parsed.data : null, cvId: cv.id as string, role });
  const mode = app.interview_answer_mode === "typed" ? "typed" : "voice";
  const { progress, messages } = openScript(plan, mode);

  const { data: session, error } = await admin
    .from("interview_sessions")
    // started_at/deadline_at are set by the DB trigger from the DB clock.
    .insert({ application_id: app.id, user_id: userId, plan, progress, answer_mode: mode, deadline_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error || !session) {
    if (error?.code === "23505") return getInterviewState(admin, userId, applicationId); // a concurrent start won
    throw new InterviewError(error?.message ?? "Could not start the interview", 500);
  }

  const { error: msgErr } = await admin.from("interview_messages").insert(messageRows(session.id, messages));
  if (msgErr) {
    await admin.from("interview_sessions").delete().eq("id", session.id);
    throw new InterviewError(msgErr.message, 500);
  }

  // An admin may have released a below-hurdle hold ("advanced" while still at the interview stage).
  if (app.status === "advanced") {
    await admin.from("applications").update({ status: "in_progress" }).eq("id", app.id).eq("status", "advanced");
  }
  return getInterviewState(admin, userId, applicationId);
}

// ───────────────────────── State ─────────────────────────

/** The stored answer for the current turn whose next question hasn't been produced yet. */
function pendingAnswer(rows: readonly MessageRow[], progress: Progress): MessageRow | null {
  return rows.find((m) => m.role === "candidate" && m.meta?.turn !== undefined && String(m.meta.turn) === String(progress.turn)) ?? null;
}

function toView(app: ApplicationRow, s: SessionRow, rows: readonly MessageRow[]): InterviewView {
  const total = s.plan.questions.length;
  const messages: InterviewMessageView[] = rows.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    step: m.step,
    label: m.role === "interviewer" ? labelFor(m.step, m.meta, total) : null,
    at: m.created_at,
  }));
  const done = !!s.ended_at;
  const cur = s.progress.current;
  return {
    status: done ? "done" : "active",
    sessionId: s.id,
    messages,
    deadlineAt: s.deadline_at,
    serverNow: new Date().toISOString(),
    done,
    endReason: s.end_reason,
    current: done || s.progress.done ? null : { label: cur.step === "probe" ? "Follow-up" : `Question ${cur.questionNo} of ${total}`, text: cur.text },
    totalQuestions: total,
    turn: s.progress.turn,
    pending: !done && !!pendingAnswer(rows, s.progress),
    notice: done ? null : s.locked_at ? LOCKED_NOTICE : statusNotice(app),
    answerMode: s.answer_mode,
    locked: !done && !!s.locked_at,
    tabLeaves: s.tab_leaves,
  };
}

export async function getInterviewState(
  admin: SupabaseClient,
  userId: string,
  applicationId: string,
  defer?: Defer,
): Promise<InterviewView> {
  const app = await ownApplication(admin, userId, applicationId);
  let s = await sessionFor(admin, app.id);
  if (!s) return { status: "none" };
  if (!s.ended_at && (s.progress.done || isExpired(s))) {
    // progress.done without ended_at means a crash between the two writes: finish the job.
    await endInterview(admin, s.id, s.progress.done ? "completed" : "timeout", defer);
    s = (await sessionFor(admin, app.id))!;
  }

  let rows = await loadMessages(admin, s.id);
  const pending = s.ended_at ? null : pendingAnswer(rows, s.progress);
  if (pending && Date.now() - new Date(pending.created_at).getTime() > PENDING_RECOVERY_MS) {
    // The request that stored this answer never moved the script on (crash or kill): do it now.
    // A failure here must not lock the candidate out of their own state; the next read retries.
    try {
      await processAnswer(admin, userId, s, pending, defer);
    } catch (err) {
      console.error("could not finish a pending interview answer", s.id, err instanceof Error ? err.message : err);
    }
    s = (await sessionFor(admin, app.id))!;
    rows = await loadMessages(admin, s.id);
  }
  return toView(app, s, rows);
}

/**
 * The candidate ends the interview before the last question. Everything answered so far is kept
 * and graded the same way; unanswered topics simply have no evidence. Never a rejection.
 */
export async function endInterviewEarly(admin: SupabaseClient, userId: string, applicationId: string, defer?: Defer): Promise<InterviewView> {
  const app = await ownApplication(admin, userId, applicationId);
  const s = await sessionFor(admin, app.id);
  if (!s) throw new InterviewError("The interview hasn't started yet", 409);
  if (s.locked_at && !s.ended_at) throw new InterviewError("This interview is locked until our team reopens it", 409);
  if (!s.ended_at) await endInterview(admin, s.id, isExpired(s) ? "timeout" : "ended_by_candidate", defer);
  return getInterviewState(admin, userId, applicationId, defer);
}

// ───────────────────────── Message ─────────────────────────

type Live = Extract<InterviewView, { status: "active" | "done" }>;

function withAnswer(state: InterviewView, outcome: "saved" | "late"): InterviewView {
  return state.status === "none" ? state : ({ ...state, lastAnswer: outcome } satisfies Live);
}

export async function postInterviewMessage(
  admin: SupabaseClient,
  userId: string,
  applicationId: string,
  input: { content: string; turn: number },
  defer?: Defer,
): Promise<InterviewView> {
  const text = input.content.trim();
  if (!text || text.length > 4000) throw new InterviewError("Answers must be between 1 and 4,000 characters", 400);
  if (!Number.isInteger(input.turn) || input.turn < 0) throw new InterviewError("Invalid request", 400);
  const app = await ownApplication(admin, userId, applicationId);
  const s = await sessionFor(admin, app.id);
  if (!s) throw new InterviewError("Start the interview first", 409);
  const current = () => getInterviewState(admin, userId, applicationId, defer);

  if (s.ended_at || s.progress.done || isExpired(s)) {
    const state = await current(); // ends the session lazily if needed
    if (state.status !== "none" && state.endReason === "timeout") return withAnswer(state, "late");
    throw new InterviewConflict("The interview has already finished, so this answer wasn't needed.", state);
  }
  if (s.answer_mode !== "typed") {
    throw new InterviewConflict("Answers to this interview are spoken. Use the Record button to answer.", await current());
  }
  await assertCanAnswer(app, s, input.turn, current);

  // 1. Store the answer before anything slow, so the DB timestamps it against the deadline.
  const { data: row, error: insErr } = await admin
    .from("interview_messages")
    .insert({
      session_id: s.id,
      role: "candidate",
      content: text,
      step: s.progress.current.step,
      claim_id: s.progress.current.claimId,
      meta: { idx: s.progress.msgCount, turn: s.progress.turn, question_no: s.progress.current.questionNo },
    })
    .select("id, role, content, step, meta, created_at")
    .single<MessageRow>();
  if (insErr || !row) {
    if (insErr?.message.includes("interview_deadline_passed")) {
      await endInterview(admin, s.id, "timeout", defer);
      return withAnswer(await current(), "late");
    }
    if (insErr?.message.includes("session_locked")) throw new InterviewConflict(LOCKED_NOTICE, await current());
    if (insErr?.code === "23505") {
      throw new InterviewConflict(
        "Your answer to this question was already received. The conversation has been refreshed.",
        await current(),
      );
    }
    throw new InterviewError(insErr?.message ?? "Could not save your answer", 500);
  }

  // 2. Decide what comes next (JEV with a bounded wait, else the fallback rule) and move on.
  await processAnswer(admin, userId, s, row, defer);
  return withAnswer(await current(), "saved");
}

/** Refuses an answer when the session is locked, paused for review, or the turn is stale. */
async function assertCanAnswer(
  app: ApplicationRow,
  s: SessionRow,
  turn: number,
  current: () => Promise<InterviewView>,
): Promise<void> {
  if (s.locked_at) throw new InterviewConflict(LOCKED_NOTICE, await current());
  const notice = statusNotice(app);
  if (notice) throw new InterviewConflict(notice, await current());
  if (turn !== s.progress.turn) {
    throw new InterviewConflict(
      "That question was already answered (perhaps in another tab, or the answer was sent twice). The conversation has been refreshed: check it before you answer again.",
      await current(),
    );
  }
}

/**
 * A spoken answer. The recording is stored and the answer row inserted FIRST (so the DB
 * timestamps it against the deadline), then it is transcribed, then the conversation moves on.
 * Typed answers are refused here unless the session is in voice mode, and vice versa.
 */
export async function postInterviewAudio(
  admin: SupabaseClient,
  userId: string,
  applicationId: string,
  input: { turn: number; audio: Buffer; mime: string; durationMs: number | null },
  defer?: Defer,
): Promise<InterviewView> {
  const mime = input.mime.split(";")[0].trim().toLowerCase();
  const format = AUDIO_TYPES[mime];
  if (!format) throw new InterviewError("Unsupported audio format", 400);
  if (input.audio.length === 0 || input.audio.length > MAX_AUDIO_BYTES) throw new InterviewError("The recording is empty or too long", 400);
  if (!Number.isInteger(input.turn) || input.turn < 0) throw new InterviewError("Invalid request", 400);

  const app = await ownApplication(admin, userId, applicationId);
  const s = await sessionFor(admin, app.id);
  if (!s) throw new InterviewError("Start the interview first", 409);
  const current = () => getInterviewState(admin, userId, applicationId, defer);
  if (s.ended_at || s.progress.done || isExpired(s)) {
    const state = await current();
    if (state.status !== "none" && state.endReason === "timeout") return withAnswer(state, "late");
    throw new InterviewConflict("The interview has already finished, so this answer wasn't needed.", state);
  }
  if (s.answer_mode !== "voice") throw new InterviewConflict("This interview takes typed answers.", await current());
  await assertCanAnswer(app, s, input.turn, current);

  // 1. Keep the recording (with the rest of the candidate's data until the retention purge).
  const ext = format === "m4a" ? "m4a" : format;
  const audioPath = `${userId}/${s.id}/turn-${input.turn}-${Date.now()}.${ext}`;
  const { error: upErr } = await admin.storage.from("interview-audio").upload(audioPath, input.audio, { contentType: mime, upsert: false });
  if (upErr) throw new InterviewError(`Could not save the recording: ${upErr.message}`, 500);

  // 2. Store the answer row now; the transcript replaces the placeholder below.
  const { data: row, error: insErr } = await admin
    .from("interview_messages")
    .insert({
      session_id: s.id,
      role: "candidate",
      content: TRANSCRIBING_PLACEHOLDER,
      step: s.progress.current.step,
      claim_id: s.progress.current.claimId,
      meta: {
        idx: s.progress.msgCount,
        turn: s.progress.turn,
        question_no: s.progress.current.questionNo,
        audio_path: audioPath,
        audio_mime: mime,
        audio_bytes: input.audio.length,
        duration_ms: input.durationMs,
        transcribed: false,
      },
    })
    .select("id, role, content, step, meta, created_at")
    .single<MessageRow>();
  if (insErr || !row) {
    await admin.storage.from("interview-audio").remove([audioPath]);
    if (insErr?.message.includes("interview_deadline_passed")) {
      await endInterview(admin, s.id, "timeout", defer);
      return withAnswer(await current(), "late");
    }
    if (insErr?.message.includes("session_locked")) throw new InterviewConflict(LOCKED_NOTICE, await current());
    if (insErr?.code === "23505") {
      throw new InterviewConflict("Your answer to this question was already received. The conversation has been refreshed.", await current());
    }
    throw new InterviewError(insErr?.message ?? "Could not save your answer", 500);
  }

  // 3. Transcribe, then move on.
  const transcribed = await ensureTranscribed(admin, row, input.audio);
  await processAnswer(admin, userId, s, transcribed, defer);
  return withAnswer(await current(), "saved");
}

/** Replaces the placeholder content of a spoken answer with its transcript (once). */
async function ensureTranscribed(admin: SupabaseClient, row: MessageRow, audio?: Buffer): Promise<MessageRow> {
  const meta = row.meta ?? {};
  if (!meta.audio_path || meta.transcribed === true) return row;
  let buf = audio;
  if (!buf) {
    const { data } = await admin.storage.from("interview-audio").download(String(meta.audio_path));
    buf = data ? Buffer.from(await data.arrayBuffer()) : undefined;
  }
  const format = AUDIO_TYPES[String(meta.audio_mime ?? "")] ?? "webm";
  const env = serverEnv();
  const started = Date.now();
  let content = TRANSCRIPTION_FAILED_PLACEHOLDER;
  let error: string | null = null;
  let model: string | null = null;
  if (buf) {
    const { value, timedOut } = await withBudget(
      transcribe(buf, { model: env.OPENROUTER_MODEL_TRANSCRIBE, format, language: "en" }).catch((e) => {
        error = e instanceof Error ? e.message.slice(0, 300) : String(e);
        return null;
      }),
      TRANSCRIBE_BUDGET_MS,
    );
    if (timedOut) error = "transcription timed out";
    if (value) {
      model = value.model;
      const clean = sanitise(value.text).text.slice(0, 5900);
      content = clean.trim() ? clean : NO_SPEECH_PLACEHOLDER;
    }
  } else {
    error = "recording not found";
  }
  const newMeta = {
    ...meta,
    transcribed: true,
    transcription: { model, ms: Date.now() - started, chars: content.length, error },
  };
  await admin.from("interview_messages").update({ content, meta: newMeta }).eq("id", row.id);
  return { ...row, content, meta: newMeta };
}

/**
 * Writes the follow-up question with an LLM from what the candidate said on this topic, with a
 * time budget. Returns null (so the template is used) on any failure.
 */
async function generateFollowup(
  admin: SupabaseClient,
  s: SessionRow,
  rows: readonly MessageRow[],
  target: string,
): Promise<{ output: FollowupOutput | null; model: string | null; promptVersion: string; error: string | null }> {
  const prompt = loadPrompt(FOLLOWUP_PROMPT.key, FOLLOWUP_PROMPT.version);
  const topic = s.plan.claims.find((c) => c.id === s.progress.current.claimId) ?? null;
  const topicRows = rows.filter((m) => m.role === "candidate" || m.step === "warmup" || m.step === "claim" || m.step === "probe").filter((m) => {
    const claimId = (m as MessageRow & { claim_id?: string | null }).claim_id;
    return claimId === undefined || claimId === s.progress.current.claimId;
  });
  const conversation = topicRows.map((m) => `${m.role === "interviewer" ? "Interviewer" : "Candidate"}: ${m.content}`).join("\n\n");
  const { data: cvRow } = s.plan.cvId ? await admin.from("cvs").select("parsed").eq("id", s.plan.cvId).maybeSingle() : { data: null };
  const env = serverEnv();
  const model = env.OPENROUTER_MODEL_INTERVIEWER ?? env.OPENROUTER_MODEL_PERSONA;
  let error: string | null = null;
  const { value, timedOut } = await withBudget(
    chatJson({
      model,
      system: prompt.system,
      user: [
        `ROLE: ${s.plan.role.title}`,
        `ROLE NEEDS:\n${requirementsFor(s.plan.role.slug).map((r) => `- ${r.text}`).join("\n")}`,
        `TOPIC: ${
          topic
            ? `${topic.kind}: ${topic.text}${topic.requirement ? ` (evidence for: ${topic.requirement.text})` : ""}`
            : `opening question (why the candidate fits the role): ${s.plan.questions[s.progress.qIdx]?.text ?? s.progress.current.text}`
        }`,
        `TARGET: ${target}`,
        `CV:\n${wrapUntrusted("cv", JSON.stringify(cvRow?.parsed ?? {}))}`,
        `CONVERSATION:\n${wrapUntrusted("conversation", conversation.slice(-12_000))}`,
      ].join("\n\n"),
      schema: FollowupOutput,
      promptVersion: prompt.promptVersion,
      temperature: 0.4,
    }).catch((e) => {
      error = e instanceof Error ? e.message.slice(0, 300) : String(e);
      return null;
    }),
    FOLLOWUP_BUDGET_MS,
  );
  if (timedOut) error = "follow-up timed out";
  return { output: value?.data ?? null, model: value?.model ?? null, promptVersion: prompt.promptVersion, error };
}

/**
 * Classifies a stored answer and moves the script on: the cursor (compare-and-set on
 * progress.turn), the answer's classification meta and the interviewer's reply are written in
 * one transaction. Losing the compare-and-set means another request already did this turn.
 */
async function processAnswer(admin: SupabaseClient, userId: string, s: SessionRow, rawAnswer: MessageRow, defer?: Defer): Promise<void> {
  const answer = await ensureTranscribed(admin, rawAnswer);
  const classification = await classifyTurn({
    plan: s.plan,
    progress: s.progress,
    message: answer.content,
    remainingMs: remainingMs(s),
    jevBudgetMs: JEV_TURN_BUDGET_MS,
  });
  const meta: Record<string, unknown> & typeof classification.meta = { ...classification.meta };

  let decision: TurnDecision;
  if (classification.kind !== "answer") decision = { kind: classification.kind };
  else if (classification.followupTarget) {
    const rows = await loadMessagesWithClaims(admin, s.id);
    const previous = rows.filter((m) => m.role === "interviewer" && m.claim_id === s.progress.current.claimId).map((m) => m.content);
    const gen = await generateFollowup(admin, s, rows, classification.followupTarget);
    const followup = resolveFollowup(gen.output, classification.followupTarget, previous);
    decision = { kind: "answer", followup: { text: followup.text, target: followup.target, via: followup.via } };
    meta.followup = { via: followup.via, rejected: followup.rejected, model: gen.model, prompt_version: gen.promptVersion, error: gen.error };
  } else decision = { kind: "answer", followup: null };

  const turn = applyTurn(s.plan, s.progress, decision, { remainingMs: remainingMs(s) });

  if (!turn.done && isExpired(s)) {
    // Time ran out while deciding. The answer is already saved; record the decision and end.
    await admin.from("interview_messages").update({ meta: { ...answer.meta, ...meta } }).eq("id", answer.id);
    await endInterview(admin, s.id, "timeout", defer);
    return;
  }

  // Each interviewer reply records how the branch was decided (JEV or fallback rule).
  const replies = turn.messages.map((m) => ({
    content: m.content,
    step: m.step,
    claim_id: m.claimId,
    meta: { ...m.meta, decided_via: meta.via, jev_model: meta.jev?.model ?? null },
  }));
  const { data: advanced, error } = await admin.rpc("interview_advance", {
    p_session_id: s.id,
    p_from_turn: s.progress.turn,
    p_progress: turn.progress,
    p_messages: replies,
    p_candidate_message_id: answer.id,
    p_candidate_meta: meta,
  });
  if (error) throw new InterviewError(error.message, 500);
  if (advanced !== true) return;

  // Only the regex detector counts as an injection attempt. A JEV-only off-script turn (for
  // example an honest "how is this scored?") is recorded in the message meta, not as a signal.
  if (meta.regex_injection) {
    await logInjectionSignal(admin, userId, "interview", {
      session_id: s.id,
      turn: s.progress.turn,
      via: "regex",
      jev_off_script: meta.jev?.off_script ?? null,
    });
  }

  if (turn.done) await endInterview(admin, s.id, "completed", defer);
}

// ───────────────────────── End ─────────────────────────

/**
 * Ends a session once (compare-and-set on ended_at), adds the closing message, moves the
 * application interview → quiz (the only automatic stage move, and only from in_progress, so an
 * admin hold or rejection is left alone), and queues grading. Returns false if already ended.
 */
export async function endInterview(
  admin: SupabaseClient,
  sessionId: string,
  reason: "completed" | "timeout" | "ended_by_candidate",
  defer?: Defer,
): Promise<boolean> {
  const { data: s, error } = await admin.from("interview_sessions").select(SESSION_COLS).eq("id", sessionId).maybeSingle<SessionRow>();
  if (error) throw new InterviewError(error.message, 500);
  if (!s || s.ended_at) return false;

  // A stored-but-unprocessed answer already holds index msgCount.
  const { count } = await admin.from("interview_messages").select("id", { count: "exact", head: true }).eq("session_id", s.id);
  const closingIdx = Math.max(s.progress.msgCount, count ?? 0);
  // A timeout ended when the deadline (+ grace) passed, even if it is noticed later.
  const endedAt =
    reason === "timeout"
      ? new Date(Math.min(Date.now(), new Date(s.deadline_at).getTime() + INTERVIEW_GRACE_MS)).toISOString()
      : new Date().toISOString();
  const { data: ended, error: endErr } = await admin
    .from("interview_sessions")
    .update({
      ended_at: endedAt,
      end_reason: reason,
      progress: { ...s.progress, done: true, msgCount: closingIdx + 1 },
    })
    .eq("id", s.id)
    .is("ended_at", null)
    .select("id");
  if (endErr) throw new InterviewError(endErr.message, 500);
  if (!ended?.length) return false;

  await admin.from("interview_messages").insert({
    session_id: s.id,
    role: "interviewer",
    content: reason === "completed" ? CLOSING_COMPLETED : reason === "timeout" ? CLOSING_TIMEOUT : CLOSING_ENDED,
    step: "close",
    claim_id: null,
    meta: { idx: closingIdx, reason },
  });

  const { error: moveErr } = await admin
    .from("applications")
    .update({ stage: "quiz", status: "in_progress" })
    .eq("id", s.application_id)
    .eq("stage", "interview")
    .in("status", OPEN_STATUSES);
  if (moveErr) console.error("could not move application to quiz", s.application_id, moveErr.message);

  // A closed application (rejected/withdrawn/lapsed) is not graded automatically.
  const { data: appRow } = await admin.from("applications").select("status").eq("id", s.application_id).maybeSingle();
  if (appRow && CLOSED_STATUSES.includes(appRow.status as string)) return true;

  const jobId = await enqueueGrading(admin, "interview", s.id);
  defer?.(() => runGradingJob(admin, jobId));
  return true;
}

/** Cron sweep: ends every session past its deadline (+ grace) and queues its grading. */
export async function endExpiredInterviews(admin: SupabaseClient, defer?: Defer): Promise<number> {
  const cutoff = new Date(Date.now() - INTERVIEW_GRACE_MS).toISOString();
  const { data, error } = await admin
    .from("interview_sessions")
    .select("id, progress")
    .is("ended_at", null)
    .is("locked_at", null)
    .lt("deadline_at", cutoff)
    .limit(200);
  if (error) throw new InterviewError(error.message, 500);
  let n = 0;
  for (const row of (data ?? []) as Pick<SessionRow, "id" | "progress">[]) {
    if (await endInterview(admin, row.id, row.progress?.done ? "completed" : "timeout", defer)) n++;
  }
  return n;
}

// ───────────────────────── Grading handler ('interview') ─────────────────────────

const Concerns = z.object({
  verification_concerns: z
    .array(z.object({ claim: z.string().trim().min(1).max(800), reason: z.string().trim().min(1).max(1200) }))
    .max(12)
    .nullish()
    .transform((v) => v ?? []),
  live_followups: z
    .array(z.string().trim().min(1).max(800))
    .min(3)
    .max(6)
    .transform((v) => v.slice(0, 3)),
});

export type InterviewSummary = {
  rubric: { id: string; key: string; version: number };
  graded_at: string;
  no_answers?: boolean;
  criteria: {
    key: string;
    title: string;
    weight: number;
    median: number | null;
    spread: number | null;
    final_score: number | null;
    human_score: number | null;
    needs_human_review: boolean;
    review_reason: string | null;
    valid_samples: number;
    evidence: { quote: string; location: string }[];
    feedback: string | null;
  }[];
  verification_concerns: { claim: string; reason: string }[];
  live_followups: string[];
  concerns_model: string | null;
  concerns_prompt_version: string | null;
  /** Set when the concerns call failed; the criterion scores and the session score still stand. */
  concerns_error?: string | null;
  transcript_flags: string[];
};

/** Grades a finished interview: 6 criteria × 3 samples, then concerns + live follow-ups. */
export async function gradeInterviewSession(admin: SupabaseClient, sessionId: string): Promise<void> {
  const { data: s, error } = await admin.from("interview_sessions").select(SESSION_COLS).eq("id", sessionId).maybeSingle<SessionRow>();
  if (error) throw new GradingError(error.message);
  if (!s) throw new GradingError("Interview session not found", 404);
  if (!s.ended_at) throw new GradingError("Interview has not ended yet", 409);

  const { data: rubricRow, error: rErr } = await admin
    .from("rubrics")
    .select("id, key, version, title, criteria, generic_baseline")
    .eq("key", INTERVIEW_RUBRIC.key)
    .eq("version", INTERVIEW_RUBRIC.version)
    .single();
  if (rErr || !rubricRow) throw new GradingError(`interview rubric missing: ${rErr?.message ?? ""}`);
  const rubric = RubricRow.parse(rubricRow);
  const criteria = rubric.criteria.filter((c) => c.method === "llm");

  const rows = await loadMessages(admin, s.id);
  const transcript = renderTranscript(rows.map((m): TranscriptMessage => ({ role: m.role, content: m.content, step: m.step })));

  const model = serverEnv().OPENROUTER_MODEL_GRADER;
  const grader = loadPrompt(GRADER_PROMPT.key, GRADER_PROMPT.version);
  const base: InterviewSummary = {
    rubric: { id: rubric.id, key: rubric.key, version: rubric.version },
    graded_at: new Date().toISOString(),
    criteria: [],
    verification_concerns: [],
    live_followups: [],
    concerns_model: null,
    concerns_prompt_version: null,
    transcript_flags: transcript.flags,
  };

  if (transcript.candidateWords === 0) {
    // Nothing to grade: flag every criterion for a human instead of inventing scores.
    for (const c of criteria) {
      const saved = await upsertSummary(admin, {
        subject_type: "interview",
        subject_id: s.id,
        rubric_id: rubric.id,
        criterion_key: c.key,
        weight: c.weight,
        median_score: null,
        spread: null,
        needs_human_review: true,
        review_reason: "No answers were given before the interview ended",
        feedback: null,
      });
      base.criteria.push({
        key: c.key, title: c.title, weight: c.weight, median: null, spread: null, final_score: saved.finalScore,
        human_score: saved.humanScore, needs_human_review: saved.needsHumanReview, review_reason: "No answers were given before the interview ended",
        valid_samples: 0, evidence: [], feedback: null,
      });
    }
    // Null unless a human has already scored criteria by hand.
    const humanMean = weightedMean(base.criteria.map((c) => ({ value: c.final_score === null ? null : criterionTo100(c.final_score), weight: c.weight })));
    const { error: upErr } = await admin
      .from("interview_sessions")
      .update({
        summary: { ...base, no_answers: true },
        score: humanMean === null ? null : Math.round(humanMean * 10) / 10,
        model,
        prompt_version: grader.promptVersion,
      })
      .eq("id", s.id);
    if (upErr) throw new GradingError(upErr.message);
    return;
  }

  await screenSubjectForInjection(admin, {
    userId: s.user_id,
    context: "interview_grading",
    subjectType: "interview",
    subjectId: s.id,
    text: transcript.candidateText,
  });

  const { data: cvRow } = s.plan.cvId
    ? await admin.from("cvs").select("parsed").eq("id", s.plan.cvId).maybeSingle()
    : { data: null };
  const cvBlock = wrapUntrusted("cv", JSON.stringify(cvRow?.parsed ?? {}));
  const header = `ROLE: ${s.plan.role.title} (${s.plan.role.slug})`;

  const results = await mapLimit(criteria, CRITERIA_CONCURRENCY, (criterion) =>
    gradeCriterion(admin, {
      subjectType: "interview",
      subjectId: s.id,
      rubricId: rubric.id,
      criterion,
      system: grader.system,
      userContent: [header, criterionBlock(criterion), `CV:\n${cvBlock}`, transcript.formatNote, `TRANSCRIPT:\n${transcript.wrapped}`].join("\n\n"),
      subjectText: transcript.candidateText,
      promptVersion: grader.promptVersion,
      model,
      signal: { userId: s.user_id, context: "interview_grading" },
    }),
  );

  // Concerns are a separate, optional extra: a failure here must not throw away the 18
  // stored criterion samples or leave the session without a score.
  const concernsPrompt = loadPrompt(CONCERNS_PROMPT.key, CONCERNS_PROMPT.version);
  let concerns: Pick<InterviewSummary, "verification_concerns" | "live_followups" | "concerns_model" | "concerns_prompt_version" | "concerns_error">;
  try {
    const res = await chatJson({
      model,
      system: concernsPrompt.system,
      user: [header, `CV:\n${cvBlock}`, transcript.formatNote, `TRANSCRIPT:\n${transcript.wrapped}`].join("\n\n"),
      schema: Concerns,
      promptVersion: concernsPrompt.promptVersion,
      temperature: 0.2,
    });
    concerns = {
      verification_concerns: res.data.verification_concerns,
      live_followups: res.data.live_followups,
      concerns_model: res.model,
      concerns_prompt_version: res.promptVersion,
      concerns_error: null,
    };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    console.error("interview concerns call failed", s.id, message);
    concerns = {
      verification_concerns: [],
      live_followups: [],
      concerns_model: model,
      concerns_prompt_version: concernsPrompt.promptVersion,
      concerns_error: message,
    };
  }

  const summary: InterviewSummary = {
    ...base,
    criteria: results.map((r) => {
      const c = criteria.find((x) => x.key === r.criterionKey)!;
      const rep = r.samples.find((x) => x.idx === r.representativeIdx);
      return {
        key: r.criterionKey,
        title: c.title,
        weight: r.weight,
        median: r.median,
        spread: r.spread,
        final_score: r.finalScore,
        human_score: r.humanScore,
        needs_human_review: r.needsHumanReview,
        review_reason: r.reviewReason,
        valid_samples: r.validCount,
        evidence: rep?.evidence ?? [],
        feedback: r.feedback,
      };
    }),
    ...concerns,
  };

  const mean = weightedMean(results.map((r) => ({ value: r.finalScore === null ? null : criterionTo100(r.finalScore), weight: r.weight })));
  const usedModel = results.flatMap((r) => r.samples.map((x) => x.model))[0] ?? model;
  const { error: upErr } = await admin
    .from("interview_sessions")
    .update({
      summary,
      score: mean === null ? null : Math.round(mean * 10) / 10,
      model: usedModel,
      prompt_version: grader.promptVersion,
    })
    .eq("id", s.id);
  if (upErr) throw new GradingError(upErr.message);
}
