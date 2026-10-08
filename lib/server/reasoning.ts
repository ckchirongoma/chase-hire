import "server-only";
import { randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assembleAttempt } from "@/lib/reasoning/blueprint";
import { scoreAttempt } from "@/lib/reasoning/scoring";
import { GRACE_MS } from "@/lib/reasoning/timer";
import { isSuspiciouslyFast } from "@/lib/reasoning/signals";
import type { ItemStem, Tier } from "@/lib/reasoning/types";

/**
 * Reasoning Assessment flow. All functions take the service-role client and an
 * already-authenticated user id. Answer keys never leave this module.
 */

export class ReasoningError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export type ServedItem = { position: number; total: number; stem: ItemStem; options: string[] };
export type Result = { rawScore: number; percentile: number; stars: number; normVersion: string; submittedAt: string };
export type ReasoningState =
  | { status: "none" }
  | { status: "active"; attemptId: string; deadlineAt: string; serverNow: string; item: ServedItem }
  | { status: "done"; attemptId: string; result: Result }
  | { status: "locked"; attemptId: string };

type AttemptRow = {
  id: string;
  user_id: string;
  deadline_at: string;
  submitted_at: string | null;
  raw_score: number | null;
  percentile: number | null;
  stars: number | null;
  norm_version: string | null;
  item_count: number;
  locked_at: string | null;
};

const ATTEMPT_COLS = "id, user_id, deadline_at, submitted_at, raw_score, percentile, stars, norm_version, item_count, locked_at";

/** A locked attempt never expires on its own: an admin reopens it with its remaining time. */
function isExpired(a: AttemptRow, now = Date.now()) {
  return !a.locked_at && now > new Date(a.deadline_at).getTime() + GRACE_MS;
}

async function latestAttempt(admin: SupabaseClient, userId: string): Promise<AttemptRow | null> {
  const { data } = await admin
    .from("reasoning_attempts")
    .select(ATTEMPT_COLS)
    .eq("user_id", userId)
    .eq("form", "online")
    .order("started_at", { ascending: false })
    .limit(1);
  return (data?.[0] as AttemptRow) ?? null;
}

export async function startAttempt(admin: SupabaseClient, userId: string): Promise<ReasoningState> {
  const { data: cv } = await admin.from("cvs").select("id").eq("user_id", userId).eq("status", "parsed").limit(1);
  if (!cv?.length) throw new ReasoningError("Upload your CV before starting the assessment", 403);

  const existing = await latestAttempt(admin, userId);
  if (existing && !existing.submitted_at) return getState(admin, userId);

  const seed = randomInt(1, 2 ** 31 - 1);
  const { data: attempt, error } = await admin
    .from("reasoning_attempts")
    // deadline_at is overwritten by the DB trigger from the DB clock.
    .insert({ user_id: userId, seed, deadline_at: new Date(Date.now() + 60_000).toISOString() })
    .select("id")
    .single();
  if (error || !attempt) {
    if (error?.message.includes("reasoning_retake_too_soon")) {
      throw new ReasoningError("You can take the Reasoning Assessment once every 90 days", 409);
    }
    throw new ReasoningError(error?.message ?? "Could not start", 500);
  }

  const { data: templates, error: tErr } = await admin
    .from("reasoning_items")
    .select("id, family, tier")
    .eq("form", "online")
    .eq("active", true)
    .eq("version", 1);
  if (tErr || !templates) throw new ReasoningError("Item bank unavailable", 500);
  const templateId = new Map(templates.map((t) => [`${t.family}:${t.tier}`, t.id as string]));

  const rows = assembleAttempt(seed).map((item) => {
    const itemId = templateId.get(`${item.family}:${item.tier}`);
    if (!itemId) throw new ReasoningError(`Missing template ${item.family}:${item.tier}`, 500);
    return {
      attempt_id: attempt.id,
      position: item.position,
      item_id: itemId,
      family: item.family,
      tier: item.tier,
      seed: item.seed,
      rendered: { stem: item.stem, options: item.options },
      answer_key: item.answerIndex,
    };
  });
  const { error: rErr } = await admin.from("reasoning_responses").insert(rows);
  if (rErr) {
    await admin.from("reasoning_attempts").delete().eq("id", attempt.id);
    throw new ReasoningError(rErr.message, 500);
  }
  return getState(admin, userId);
}

/** Current state; serves the next item if none is outstanding; finalises expired attempts. */
export async function getState(admin: SupabaseClient, userId: string): Promise<ReasoningState> {
  const attempt = await latestAttempt(admin, userId);
  if (!attempt) return { status: "none" };
  if (attempt.submitted_at) return done(attempt);
  if (attempt.locked_at) return { status: "locked", attemptId: attempt.id };
  if (isExpired(attempt)) return done(await finalise(admin, attempt.id));

  const item = await currentOrNextItem(admin, attempt);
  if (!item) return done(await finalise(admin, attempt.id));
  return {
    status: "active",
    attemptId: attempt.id,
    deadlineAt: attempt.deadline_at,
    serverNow: new Date().toISOString(),
    item,
  };
}

/** Records an answer (or a skip when answer is null) for the item at `position`, then serves the next. */
export async function answer(
  admin: SupabaseClient,
  userId: string,
  attemptId: string,
  position: number,
  choice: number | null,
): Promise<ReasoningState> {
  const attempt = await latestAttempt(admin, userId);
  if (!attempt || attempt.id !== attemptId) throw new ReasoningError("Attempt not found", 404);
  if (attempt.submitted_at || attempt.locked_at || isExpired(attempt)) return getState(admin, userId);

  // Only the currently served, unanswered item can be answered. Anything else
  // (a double-click or a retried request) is ignored and the current state returned.
  const { data: rows, error } = await admin
    .from("reasoning_responses")
    .update({ answer: choice, answered_at: new Date().toISOString() })
    .eq("attempt_id", attemptId)
    .eq("position", position)
    .not("served_at", "is", null)
    .is("answered_at", null)
    .select("tier, served_at, answered_at, correct");
  if (error) {
    if (error.message.includes("reasoning_deadline_passed") || error.message.includes("session_locked")) return getState(admin, userId);
    throw new ReasoningError(error.message, 500);
  }

  const row = rows?.[0];
  if (row?.correct && row.served_at && row.answered_at) {
    const ms = new Date(row.answered_at).getTime() - new Date(row.served_at).getTime();
    if (isSuspiciouslyFast({ tier: row.tier as Tier, correct: true, ms })) {
      await admin.from("signals").insert({
        user_id: userId,
        context: "reasoning",
        kind: "answer_time",
        payload: { attempt_id: attemptId, position, ms, tier: row.tier },
      });
    }
  }
  return getState(admin, userId);
}

async function currentOrNextItem(admin: SupabaseClient, attempt: AttemptRow): Promise<ServedItem | null> {
  const { data: current } = await admin
    .from("reasoning_responses")
    .select("position, rendered")
    .eq("attempt_id", attempt.id)
    .not("served_at", "is", null)
    .is("answered_at", null)
    .order("position")
    .limit(1);
  let row = current?.[0];

  if (!row) {
    const { data: next } = await admin
      .from("reasoning_responses")
      .select("position")
      .eq("attempt_id", attempt.id)
      .is("served_at", null)
      .order("position")
      .limit(1);
    if (!next?.length) return null;
    const { data: served } = await admin
      .from("reasoning_responses")
      .update({ served_at: new Date().toISOString() })
      .eq("attempt_id", attempt.id)
      .eq("position", next[0].position)
      .is("served_at", null)
      .select("position, rendered");
    row = served?.[0];
    if (!row) return currentOrNextItem(admin, attempt); // lost a race with another request
  }

  const rendered = row.rendered as { stem: ItemStem; options: string[] };
  return { position: row.position, total: attempt.item_count, stem: rendered.stem, options: rendered.options };
}

export async function finalise(admin: SupabaseClient, attemptId: string): Promise<AttemptRow> {
  const { data: responses } = await admin
    .from("reasoning_responses")
    .select("correct")
    .eq("attempt_id", attemptId);
  const raw = (responses ?? []).filter((r) => r.correct === true).length;
  const score = scoreAttempt(raw);
  const { data, error } = await admin
    .from("reasoning_attempts")
    .update({
      submitted_at: new Date().toISOString(),
      raw_score: score.raw,
      percentile: score.percentile,
      stars: score.stars,
      norm_version: score.normVersion,
    })
    .eq("id", attemptId)
    .is("submitted_at", null)
    .select(ATTEMPT_COLS);
  if (error && !error.message.includes("already_submitted")) throw new ReasoningError(error.message, 500);
  if (data?.[0]) return data[0] as AttemptRow;
  // Someone else finalised it first.
  const { data: row } = await admin.from("reasoning_attempts").select(ATTEMPT_COLS).eq("id", attemptId).single();
  return row as AttemptRow;
}

/** Finalises every attempt whose deadline has passed (cron safety net). */
export async function finaliseExpired(admin: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - GRACE_MS).toISOString();
  const { data } = await admin
    .from("reasoning_attempts")
    .select("id")
    .is("submitted_at", null)
    .is("locked_at", null)
    .lt("deadline_at", cutoff)
    .limit(500);
  for (const a of data ?? []) await finalise(admin, a.id);
  return data?.length ?? 0;
}

function done(a: AttemptRow): ReasoningState {
  return {
    status: "done",
    attemptId: a.id,
    result: {
      rawScore: a.raw_score ?? 0,
      percentile: Number(a.percentile ?? 0),
      stars: a.stars ?? 1,
      normVersion: a.norm_version ?? "",
      submittedAt: a.submitted_at ?? "",
    },
  };
}
