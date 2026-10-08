import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chatJson } from "@/lib/ai";
import { serverEnv } from "@/lib/config";
import { loadPrompt } from "@/lib/prompts";
import { sanitise } from "@/lib/sanitise";
import {
  CLOSING_CAP,
  CLOSING_TIMEOUT,
  elicitationPoints,
  elicitationYield,
  gateMessage,
  hiddenFactsFor,
  intersectRevealed,
  OFF_SCRIPT_REPLY,
  offScriptIsSignal,
  OPENING_LINE,
  PERSONA_GRACE_MS,
  PERSONA_KEY,
  PERSONA_MAX_MESSAGE_CHARS,
  PERSONA_MESSAGE_CAP,
  PERSONA_PENDING_MS,
  PERSONA_PROMPT,
  PERSONA_TEMPERATURE,
  PersonaReply,
  personaSystem,
  personaUser,
  RETRY_REPLY,
  type ChatLine,
  type PersonaFact,
} from "@/lib/persona";
import type { PersonaMessageView, PersonaView } from "@/lib/persona/types";
import { logInjectionSignal } from "@/lib/server/grading";
import { storableText } from "@/lib/work/text";

export { elicitationYield, elicitationPoints } from "@/lib/persona";

/**
 * BA Part 1 stakeholder chat with "Lerato Dube" (docs/06, docs/10 persona-lerato.v1, docs/15).
 *
 * - The DB owns the clock and the cap: the session deadline is min(start + 25 min, stage
 *   deadline) and persona_message_guard refuses candidate messages after it (+5 s) or past 25.
 * - Each candidate message is stored FIRST, then gated (one JEV call, keyword fallback), then
 *   answered by the persona model, which only ever receives the facts gated this turn plus those
 *   already revealed. Stored revealed ids = the model's ids ∩ the gated set.
 * - Off-script messages get the fixed in-character line and the persona model is not called.
 *   Only the injection detector and JEV's off-script answer log a prompt_injection signal and
 *   count as a message; a dump-pattern hint (JEV down) or a keyword list (too many facts in one
 *   message) does neither.
 * - The candidate never sees fact ids, probabilities or model details.
 */

export class PersonaError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** 409 that carries the current state, so the client can refresh without losing its draft. */
export class PersonaConflict extends PersonaError {
  constructor(
    message: string,
    public state: PersonaView,
  ) {
    super(message, 409);
  }
}

type SessionRow = {
  id: string;
  attempt_id: string;
  user_id: string;
  persona_key: string;
  started_at: string;
  deadline_at: string;
  ended_at: string | null;
  candidate_messages: number;
  revealed_fact_ids: string[];
};
const SESSION_COLS = "id, attempt_id, user_id, persona_key, started_at, deadline_at, ended_at, candidate_messages, revealed_fact_ids";

type MessageRow = {
  id: string;
  role: "candidate" | "persona";
  content: string;
  revealed_fact_ids: string[];
  meta: Record<string, unknown> | null;
  created_at: string;
};

type Ctx = {
  attempt: { id: string; user_id: string; application_id: string; started_at: string | null; deadline_at: string | null; submitted_at: string | null };
  appStatus: string;
};

const CLOSED_STATUSES = ["rejected", "withdrawn", "lapsed"];

async function context(admin: SupabaseClient, userId: string, attemptId: string): Promise<Ctx> {
  const { data: attempt, error } = await admin
    .from("work_attempts")
    .select("id, user_id, application_id, started_at, deadline_at, submitted_at, work_stages(key), applications(status)")
    .eq("id", attemptId)
    .maybeSingle();
  if (error) throw new PersonaError(error.message, 500);
  const stage = (attempt?.work_stages as unknown as { key: string } | null)?.key;
  if (!attempt || attempt.user_id !== userId || stage !== "ba_part1") throw new PersonaError("Chat not found", 404);
  const appStatus = (attempt.applications as unknown as { status: string } | null)?.status ?? "";
  return { attempt: attempt as unknown as Ctx["attempt"], appStatus };
}

async function sessionFor(admin: SupabaseClient, attemptId: string): Promise<SessionRow | null> {
  const { data, error } = await admin.from("persona_sessions").select(SESSION_COLS).eq("attempt_id", attemptId).maybeSingle<SessionRow>();
  if (error) throw new PersonaError(error.message, 500);
  return data;
}

async function loadMessages(admin: SupabaseClient, sessionId: string): Promise<MessageRow[]> {
  const { data, error } = await admin
    .from("persona_messages")
    .select("id, role, content, revealed_fact_ids, meta, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw new PersonaError(error.message, 500);
  return (data ?? []) as MessageRow[];
}

export async function loadPersonaFacts(admin: SupabaseClient, personaKey = PERSONA_KEY): Promise<PersonaFact[]> {
  const { data, error } = await admin.from("persona_facts").select("id, fact, triggers, weight, volunteer_on").eq("persona_key", personaKey).order("id");
  if (error) throw new PersonaError(error.message, 500);
  return (data ?? []) as PersonaFact[];
}

const expired = (s: Pick<SessionRow, "deadline_at">, now = Date.now()) => now > new Date(s.deadline_at).getTime() + PERSONA_GRACE_MS;

function canChat(ctx: Ctx, now = Date.now()): string | null {
  if (CLOSED_STATUSES.includes(ctx.appStatus)) return "This application is closed, so the chat isn't available.";
  if (!ctx.attempt.started_at || !ctx.attempt.deadline_at) return "Press Start on the assessment first; the chat opens with it.";
  if (ctx.attempt.submitted_at) return "You've submitted this assessment, so the chat is closed.";
  if (now > new Date(ctx.attempt.deadline_at).getTime()) return "The work window has ended, so the chat is closed.";
  return null;
}

function toView(ctx: Ctx, s: SessionRow, rows: readonly MessageRow[]): PersonaView {
  const messages: PersonaMessageView[] = rows.map((m) => ({ id: m.id, role: m.role, content: m.content, at: m.created_at }));
  const last = rows[rows.length - 1];
  const closing = [...rows].reverse().find((m) => typeof m.meta?.closing === "string")?.meta?.closing as "cap" | "deadline" | undefined;
  const ended = !!s.ended_at;
  return {
    status: ended ? "closed" : "active",
    sessionId: s.id,
    messages,
    deadlineAt: s.deadline_at,
    serverNow: new Date().toISOString(),
    cap: PERSONA_MESSAGE_CAP,
    remaining: Math.max(0, PERSONA_MESSAGE_CAP - s.candidate_messages),
    pending: !ended && last?.role === "candidate" && Date.now() - new Date(last.created_at).getTime() < PERSONA_PENDING_MS,
    closedReason: ended ? (closing ?? (ctx.attempt.submitted_at ? "submitted" : "deadline")) : null,
    notice: ended ? null : canChat(ctx),
  };
}

/** Ends a session once (compare-and-set on ended_at) and adds Lerato's closing line. */
async function closeSession(admin: SupabaseClient, sessionId: string, reason: "cap" | "deadline"): Promise<boolean> {
  const { data, error } = await admin
    .from("persona_sessions")
    .update({ ended_at: new Date().toISOString() })
    .eq("id", sessionId)
    .is("ended_at", null)
    .select("id");
  if (error) throw new PersonaError(error.message, 500);
  if (!data?.length) return false;
  await admin.from("persona_messages").insert({
    session_id: sessionId,
    role: "persona",
    content: reason === "cap" ? CLOSING_CAP : CLOSING_TIMEOUT,
    meta: { closing: reason },
  });
  return true;
}

// ───────────────────────── State / start ─────────────────────────

export async function getPersonaState(admin: SupabaseClient, userId: string, attemptId: string): Promise<PersonaView> {
  const ctx = await context(admin, userId, attemptId);
  let s = await sessionFor(admin, attemptId);
  if (!s) {
    const why = canChat(ctx);
    return { status: "none", canStart: !why, notice: why, cap: PERSONA_MESSAGE_CAP };
  }
  if (!s.ended_at && expired(s)) {
    await closeSession(admin, s.id, "deadline");
    s = (await sessionFor(admin, attemptId))!;
  }
  return toView(ctx, s, await loadMessages(admin, s.id));
}

export async function startPersona(admin: SupabaseClient, userId: string, attemptId: string): Promise<PersonaView> {
  const ctx = await context(admin, userId, attemptId);
  if (await sessionFor(admin, attemptId)) return getPersonaState(admin, userId, attemptId);
  const why = canChat(ctx);
  if (why) throw new PersonaError(why, 409);

  const { data: s, error } = await admin
    .from("persona_sessions")
    // started_at/deadline_at come from the DB clock (persona_session_guard).
    .insert({ attempt_id: attemptId, user_id: userId, persona_key: PERSONA_KEY, deadline_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error || !s) {
    if (error?.code === "23505") return getPersonaState(admin, userId, attemptId);
    if (error?.message.includes("work_not_active")) throw new PersonaError("The chat is only available while your assessment is running.", 409);
    throw new PersonaError(error?.message ?? "Could not start the chat", 500);
  }
  await admin.from("persona_messages").insert({ session_id: s.id, role: "persona", content: OPENING_LINE, meta: { opening: true } });
  return getPersonaState(admin, userId, attemptId);
}

// ───────────────────────── Message ─────────────────────────

export async function postPersonaMessage(admin: SupabaseClient, userId: string, attemptId: string, content: string): Promise<PersonaView> {
  const cleaned = sanitise(storableText(content ?? ""));
  const text = cleaned.text.trim();
  if (!text || text.length > PERSONA_MAX_MESSAGE_CHARS) {
    throw new PersonaError(`Messages must be between 1 and ${PERSONA_MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters`, 400);
  }
  const ctx = await context(admin, userId, attemptId);
  const s = await sessionFor(admin, attemptId);
  if (!s) throw new PersonaError("Start the chat first", 409);
  const current = () => getPersonaState(admin, userId, attemptId);

  if (s.ended_at || expired(s)) throw new PersonaConflict("The chat with Lerato has ended.", await current());
  if (CLOSED_STATUSES.includes(ctx.appStatus)) throw new PersonaConflict("This application is closed, so the chat isn't available.", await current());

  const history = await loadMessages(admin, s.id);
  const last = history[history.length - 1];
  if (last?.role === "candidate" && Date.now() - new Date(last.created_at).getTime() < PERSONA_PENDING_MS) {
    throw new PersonaConflict("Lerato is still replying to your last message.", await current());
  }

  // 1. Store the message first: the DB counts it, caps at 25 and checks the deadline.
  const { data: row, error: insErr } = await admin
    .from("persona_messages")
    .insert({ session_id: s.id, role: "candidate", content: text, meta: cleaned.flags.length ? { sanitise_flags: cleaned.flags } : {} })
    .select("id, created_at")
    .single();
  if (insErr || !row) {
    if (insErr?.message.includes("persona_message_cap")) {
      await closeSession(admin, s.id, "cap");
      throw new PersonaConflict(`You've used all ${PERSONA_MESSAGE_CAP} messages.`, await current());
    }
    if (insErr?.message.includes("persona_chat_closed")) {
      await closeSession(admin, s.id, "deadline");
      throw new PersonaConflict("The chat with Lerato has ended, so that message wasn't sent.", await current());
    }
    throw new PersonaError(insErr?.message ?? "Could not send your message", 500);
  }

  // 2. Gate: which hidden facts this message may unlock (JEV, else keywords).
  const facts = await loadPersonaFacts(admin, s.persona_key);
  const revealed = s.revealed_fact_ids ?? [];
  const lastReply = [...history].reverse().find((m) => m.role === "persona")?.content ?? null;
  const gate = await gateMessage({ message: text, facts, revealed, lastReply });
  const gateMeta = {
    via: gate.via,
    jev_model: gate.model,
    jev_ms: gate.jevMs,
    jev_timeout: gate.jevTimeout,
    probabilities: gate.probabilities,
    gated: gate.gated,
    hits: gate.hits,
    off_script: gate.offScript,
    off_script_via: gate.offScriptVia,
  };

  // 3. Reply.
  let reply: string;
  let revealedNow: string[] = [];
  let modelMeta: Record<string, unknown> = {};
  let refund: "model_error" | "off_script_hint" | null = null;
  if (gate.offScript) {
    reply = OFF_SCRIPT_REPLY;
    if (offScriptIsSignal(gate.offScriptVia)) {
      await logInjectionSignal(admin, userId, "persona:ba_part1", {
        where: "persona_chat",
        session_id: s.id,
        via: gate.offScriptVia ?? "jev",
        regex: gate.regexInjection,
      });
    } else {
      // A pattern hint while JEV is down, or a keyword list: in character, no signal, not counted.
      refund = "off_script_hint";
    }
  } else {
    const prompt = loadPrompt(PERSONA_PROMPT.key, PERSONA_PROMPT.version);
    const hidden = hiddenFactsFor(facts, gate.gated, revealed);
    const lines: ChatLine[] = history.map((m) => ({ role: m.role, content: m.content }));
    const model = serverEnv().OPENROUTER_MODEL_PERSONA;
    try {
      const res = await chatJson({
        model,
        system: personaSystem(prompt.system, hidden),
        user: personaUser(lines, text),
        schema: PersonaReply,
        promptVersion: prompt.promptVersion,
        temperature: PERSONA_TEMPERATURE,
      });
      reply = res.data.reply;
      revealedNow = intersectRevealed(res.data.revealed_fact_ids, gate.gated);
      modelMeta = { model: res.model, prompt_version: res.promptVersion, model_revealed: res.data.revealed_fact_ids };
    } catch (err) {
      // Don't charge the candidate a message for our failure.
      console.error("persona reply failed", s.id, err instanceof Error ? err.message : err);
      reply = RETRY_REPLY;
      refund = "model_error";
      modelMeta = { model, prompt_version: prompt.promptVersion, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
  }

  const { error: repErr } = await admin.from("persona_messages").insert({
    session_id: s.id,
    role: "persona",
    content: storableText(reply).slice(0, 4000) || RETRY_REPLY,
    revealed_fact_ids: revealedNow,
    meta: { ...gateMeta, ...modelMeta, reply_to: row.id, ...(refund ? { refunded: true, refund_reason: refund } : {}) },
  });
  if (repErr) throw new PersonaError(repErr.message, 500);

  const fresh = (await sessionFor(admin, attemptId))!;
  if (refund) {
    await admin
      .from("persona_messages")
      .update({ meta: { ...(cleaned.flags.length ? { sanitise_flags: cleaned.flags } : {}), refunded: true, refund_reason: refund } })
      .eq("id", row.id);
    await admin
      .from("persona_sessions")
      .update({ candidate_messages: Math.max(0, fresh.candidate_messages - 1) })
      .eq("id", s.id)
      .eq("candidate_messages", fresh.candidate_messages);
  } else if (fresh.candidate_messages >= PERSONA_MESSAGE_CAP) {
    await closeSession(admin, s.id, "cap");
  }
  return current();
}

/** Cron/backstop: closes chats whose deadline (+ grace) has passed. */
export async function closeExpiredPersonaSessions(admin: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - PERSONA_GRACE_MS).toISOString();
  const { data, error } = await admin.from("persona_sessions").select("id").is("ended_at", null).lt("deadline_at", cutoff).limit(200);
  if (error) throw new PersonaError(error.message, 500);
  let n = 0;
  for (const r of data ?? []) if (await closeSession(admin, r.id as string, "deadline")) n++;
  return n;
}

// ───────────────────────── For graders and the admin panel ─────────────────────────

export type PersonaEvidence = {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  candidateMessages: number;
  revealedFactIds: string[];
  /** Weighted share of hidden facts revealed (0..1). */
  yield: number;
  points: number;
  maxPoints: number;
  transcript: { role: "candidate" | "persona"; content: string; revealed_fact_ids: string[]; at: string; meta: Record<string, unknown> }[];
};

/** The persona transcript for an attempt with revealed facts per message and the elicitation yield. */
export async function loadPersonaEvidence(admin: SupabaseClient, attemptId: string): Promise<PersonaEvidence | null> {
  const s = await sessionFor(admin, attemptId);
  if (!s) return null;
  const [rows, facts] = await Promise.all([loadMessages(admin, s.id), loadPersonaFacts(admin, s.persona_key)]);
  const revealed = s.revealed_fact_ids ?? [];
  const pts = elicitationPoints(revealed, facts);
  return {
    sessionId: s.id,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    candidateMessages: s.candidate_messages,
    revealedFactIds: revealed,
    yield: elicitationYield(revealed, facts),
    points: pts.points,
    maxPoints: pts.max,
    transcript: rows.map((m) => ({ role: m.role, content: m.content, revealed_fact_ids: m.revealed_fact_ids ?? [], at: m.created_at, meta: m.meta ?? {} })),
  };
}
