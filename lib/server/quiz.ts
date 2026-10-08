import "server-only";
import { randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assembleQuiz, QuizBankError, type BankItem } from "@/lib/quiz/assemble";
import { QUIZ_GRACE_MS, topicsFor } from "@/lib/quiz/blueprint";
import { normaliseAnswer, scoreQuiz, type TopicScores } from "@/lib/quiz/scoring";
import { answerTimeFlag } from "@/lib/quiz/signals";
import { refreshQuietly, refreshScores } from "@/lib/server/scores";

/**
 * Role quiz flow (doc 05 Part B). Every function takes the service-role client and an
 * already-authenticated user id, and only ever touches that user's own application.
 * The DB owns the clock (12-minute deadline set by quiz_attempt_guard) and marks each
 * answer (quiz_response_guard). Answer keys never leave this module.
 *
 * Stage rules: the quiz never moves an application to another stage. When it finishes,
 * the application goes to awaiting_review and an admin decides (admin_decide). A rejected
 * (or withdrawn/lapsed) application's quiz is frozen: it is finalised and no more items
 * are served.
 */

export class QuizError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export type QuizServedItem = { position: number; total: number; stem: string; options: string[]; multi: boolean };
export type QuizResult = { rawScore: number; total: number; pct: number; topicScores: TopicScores; submittedAt: string };
export type QuizState =
  | { status: "none"; canStart: boolean }
  | { status: "active"; attemptId: string; deadlineAt: string; serverNow: string; item: QuizServedItem }
  | { status: "done"; attemptId: string; result: QuizResult }
  /** The application is closed (rejected, withdrawn or lapsed); results are on /me/results. */
  | { status: "closed" }
  /** Locked after the candidate left the page twice; an admin reopens it with its remaining time. */
  | { status: "locked"; attemptId: string };

type AppRow = { id: string; stage: string; status: string };
type Ctx = { roleSlug: string; flagPct: number; app: AppRow };
type AttemptRow = {
  id: string;
  application_id: string;
  started_at: string;
  deadline_at: string;
  submitted_at: string | null;
  raw_score: number | null;
  pct: number | null;
  topic_scores: TopicScores | null;
  item_count: number;
  locked_at: string | null;
};

const ATTEMPT_COLS = "id, application_id, started_at, deadline_at, submitted_at, raw_score, pct, topic_scores, item_count, locked_at";
const STARTABLE_STATUSES = ["in_progress", "advanced"];
/** No further items are served once an application is closed. */
const CLOSED_STATUSES = ["rejected", "withdrawn", "lapsed"];
/** A finished quiz moves these statuses to awaiting_review ('advanced' = a hold released mid-quiz). */
const SETTLE_STATUSES = ["in_progress", "advanced"];
/**
 * quiz_create_attempt writes an attempt and its rows in one transaction, so an attempt with
 * no rows should never exist. If one does (written another way, or by an older build), it is
 * void once it is this old: the candidate never saw a question, so it is rebuilt, never scored.
 */
const EMPTY_ATTEMPT_STALE_MS = 30_000;

/** A locked attempt never expires on its own: an admin reopens it with its remaining time. */
function isExpired(a: AttemptRow, now = Date.now()) {
  return !a.locked_at && now > new Date(a.deadline_at).getTime() + QUIZ_GRACE_MS;
}

function canStart(app: AppRow) {
  return app.stage === "quiz" && STARTABLE_STATUSES.includes(app.status);
}

function isClosed(app: AppRow) {
  return CLOSED_STATUSES.includes(app.status);
}

function noAttempt(ctx: Ctx): QuizState {
  return { status: "none", canStart: canStart(ctx.app) };
}

async function findApplication(admin: SupabaseClient, userId: string, roleSlug: string): Promise<Ctx | null> {
  const { data: role, error } = await admin.from("roles").select("id, quiz_flag_pct").eq("slug", roleSlug).maybeSingle();
  if (error) throw new QuizError(error.message, 500);
  if (!role) return null;
  const { data: app, error: aErr } = await admin
    .from("applications")
    .select("id, stage, status")
    .eq("user_id", userId)
    .eq("role_id", role.id)
    .maybeSingle();
  if (aErr) throw new QuizError(aErr.message, 500);
  if (!app) return null;
  return { roleSlug, flagPct: Number(role.quiz_flag_pct), app: app as AppRow };
}

async function attemptFor(admin: SupabaseClient, applicationId: string): Promise<AttemptRow | null> {
  const { data, error } = await admin.from("quiz_attempts").select(ATTEMPT_COLS).eq("application_id", applicationId).maybeSingle();
  if (error) throw new QuizError(error.message, 500);
  return (data as AttemptRow | null) ?? null;
}

/** Starts the quiz for the user's application to `roleSlug`, or resumes the existing attempt. */
export async function startQuiz(admin: SupabaseClient, userId: string, roleSlug: string): Promise<QuizState> {
  const ctx = await findApplication(admin, userId, roleSlug);
  if (!ctx) throw new QuizError("You have not applied for this role", 404);

  const existing = await attemptFor(admin, ctx.app.id);
  if (existing) {
    const state = await stateFor(admin, ctx, existing);
    if (state) return state; // null: an empty attempt was voided; build a fresh one below
  }
  if (!canStart(ctx.app)) throw new QuizError("The role quiz is not open for this application", 403);

  const { data: bank, error: bErr } = await admin
    .from("quiz_items")
    .select("id, role_slug, topic, stem, options, answer_key, multi")
    .eq("role_slug", roleSlug)
    .eq("active", true);
  if (bErr || !bank) throw new QuizError("Quiz bank unavailable", 500);

  const seed = randomInt(1, 2 ** 31 - 1);
  let items;
  try {
    items = assembleQuiz(seed, bank as BankItem[]);
  } catch (err) {
    if (err instanceof QuizBankError) throw new QuizError(`Quiz bank incomplete: ${err.message}`, 500);
    throw err;
  }

  // One transaction: the attempt, its rows, and in_progress on the application. It re-checks
  // the stage and status under a row lock, so a decision that lands meanwhile wins.
  const { error } = await admin.rpc("quiz_create_attempt", {
    p_application_id: ctx.app.id,
    p_user_id: userId,
    p_seed: seed,
    p_items: items.map((item) => ({
      position: item.position,
      item_id: item.itemId,
      topic: item.topic,
      rendered: { stem: item.stem, options: item.options, multi: item.multi },
      answer_key: item.answerKey,
    })),
  });
  if (error && error.code !== "23505") {
    // 23505: lost a race with a second Start click; resume the attempt that won (below).
    if (error.message.includes("quiz_not_open")) throw new QuizError("The role quiz is not open for this application", 403);
    throw new QuizError(error.message, 500);
  }

  const fresh = await findApplication(admin, userId, roleSlug);
  const attempt = fresh && (await attemptFor(admin, fresh.app.id));
  if (!fresh || !attempt) throw new QuizError("Could not start the quiz", 500);
  return (await stateFor(admin, fresh, attempt)) ?? noAttempt(fresh);
}

/** Current state; serves the next item if none is outstanding; finalises finished or expired attempts. */
export async function getQuizState(admin: SupabaseClient, userId: string, roleSlug: string): Promise<QuizState> {
  const ctx = await findApplication(admin, userId, roleSlug);
  if (!ctx) return { status: "none", canStart: false };
  const attempt = await attemptFor(admin, ctx.app.id);
  if (!attempt) return noAttempt(ctx);
  return (await stateFor(admin, ctx, attempt)) ?? noAttempt(ctx);
}

/** The state of an existing attempt. Null means it was an empty attempt and has been voided. */
async function stateFor(admin: SupabaseClient, ctx: Ctx, attempt: AttemptRow): Promise<QuizState | null> {
  if (isClosed(ctx.app)) {
    // Freeze: score what was answered in time and serve nothing more.
    if (!attempt.submitted_at && !(await finaliseQuiz(admin, attempt.id))) return null;
    return { status: "closed" };
  }
  if (attempt.submitted_at) {
    await settleApplication(admin, ctx.app);
    return done(attempt);
  }
  if (attempt.locked_at) return { status: "locked", attemptId: attempt.id };
  if (isExpired(attempt)) {
    const finished = await finaliseQuiz(admin, attempt.id);
    return finished ? done(finished) : null;
  }

  const item = await currentOrNextItem(admin, attempt);
  if (item === "preparing") {
    const age = Date.now() - new Date(attempt.started_at).getTime();
    if (age > EMPTY_ATTEMPT_STALE_MS && (await voidEmptyAttempt(admin, attempt.id))) return null;
    throw new QuizError("Your quiz is being prepared. Try again in a moment.", 409);
  }
  if (!item) {
    const finished = await finaliseQuiz(admin, attempt.id);
    return finished ? done(finished) : null;
  }
  return {
    status: "active",
    attemptId: attempt.id,
    deadlineAt: attempt.deadline_at,
    serverNow: new Date().toISOString(),
    item,
  };
}

/**
 * Records the answer for the item at `position` and serves the next one. `answer` is a
 * list of 0-based option indexes; null or an empty list is a skip. Only the currently
 * served, unanswered item can be answered; anything else (a double-click, a retried
 * request, an attempt to go back) is ignored and the current state returned.
 */
export async function answerQuiz(
  admin: SupabaseClient,
  userId: string,
  roleSlug: string,
  attemptId: string,
  position: number,
  answer: readonly number[] | null,
): Promise<QuizState> {
  const ctx = await findApplication(admin, userId, roleSlug);
  if (!ctx) throw new QuizError("Attempt not found", 404);
  const attempt = await attemptFor(admin, ctx.app.id);
  if (!attempt || attempt.id !== attemptId) throw new QuizError("Attempt not found", 404);
  if (isClosed(ctx.app) || attempt.submitted_at || attempt.locked_at || isExpired(attempt)) {
    return (await stateFor(admin, ctx, attempt)) ?? noAttempt(ctx);
  }

  const { data: current } = await admin
    .from("quiz_responses")
    .select("rendered")
    .eq("attempt_id", attemptId)
    .eq("position", position)
    .not("served_at", "is", null)
    .is("answered_at", null)
    .maybeSingle();
  if (!current) return (await stateFor(admin, ctx, attempt)) ?? noAttempt(ctx);

  const rendered = current.rendered as { options: string[]; multi: boolean };
  const choice = normaliseAnswer(answer);
  if (choice) {
    if (choice.some((i) => !Number.isInteger(i) || i < 0 || i >= rendered.options.length)) {
      throw new QuizError("That option does not exist", 400);
    }
    if (!rendered.multi && choice.length > 1) throw new QuizError("Choose one answer", 400);
  }

  const { data: rows, error } = await admin
    .from("quiz_responses")
    .update({ answer: choice, answered_at: new Date().toISOString() })
    .eq("attempt_id", attemptId)
    .eq("position", position)
    .not("served_at", "is", null)
    .is("answered_at", null)
    .select("served_at, answered_at, correct");
  if (error) {
    if (error.message.includes("quiz_deadline_passed") || error.message.includes("quiz_attempt_already_submitted") || error.message.includes("session_locked")) {
      return getQuizState(admin, userId, roleSlug);
    }
    throw new QuizError(error.message, 500);
  }

  const row = rows?.[0];
  if (row?.correct && row.served_at && row.answered_at) {
    const ms = new Date(row.answered_at).getTime() - new Date(row.served_at).getTime();
    const flag = answerTimeFlag({ multi: rendered.multi, correct: true, ms });
    if (flag) {
      // A signal for a human reviewer only; it never changes the score or the status.
      await admin.from("signals").insert({
        user_id: userId,
        context: `quiz:${roleSlug}`,
        kind: "answer_time",
        payload: { attempt_id: attemptId, position, ms, flag, multi: rendered.multi },
      });
    }
  }
  return getQuizState(admin, userId, roleSlug);
}

async function currentOrNextItem(admin: SupabaseClient, attempt: AttemptRow): Promise<QuizServedItem | "preparing" | null> {
  // The item being answered, or the next one served now. One call, serialised per attempt in
  // the DB, so concurrent requests can never serve two items at once.
  const { data, error } = await admin.rpc("quiz_serve_next", { p_attempt_id: attempt.id });
  if (error) throw new QuizError(error.message, 500);
  const row = data as { position: number; rendered: { stem: string; options: string[]; multi: boolean } } | null;

  if (!row) {
    // No rows at all means the attempt was never built; don't score an empty quiz.
    const { count, error: cErr } = await admin
      .from("quiz_responses")
      .select("position", { count: "exact", head: true })
      .eq("attempt_id", attempt.id);
    if (cErr) throw new QuizError(cErr.message, 500);
    return count ? null : "preparing";
  }

  return {
    position: row.position,
    total: attempt.item_count,
    stem: row.rendered.stem,
    options: row.rendered.options,
    multi: !!row.rendered.multi,
  };
}

/**
 * Scores an attempt from the DB-marked responses, then moves the application to
 * awaiting_review (stage stays 'quiz'; an admin decides what happens next).
 * An attempt with no rows is never scored: it is voided and null is returned.
 */
export async function finaliseQuiz(admin: SupabaseClient, attemptId: string): Promise<AttemptRow | null> {
  const { data: meta, error: mErr } = await admin
    .from("quiz_attempts")
    .select("id, application_id, applications(id, stage, status, roles(slug, quiz_flag_pct))")
    .eq("id", attemptId)
    .single();
  if (mErr || !meta) throw new QuizError(mErr?.message ?? "Attempt not found", 404);
  const app = meta.applications as unknown as (AppRow & { roles: { slug: string; quiz_flag_pct: number } }) | null;
  if (!app) throw new QuizError("Application not found", 404);

  const { data: responses, error: rErr } = await admin.from("quiz_responses").select("topic, correct").eq("attempt_id", attemptId);
  if (rErr) throw new QuizError(rErr.message, 500);
  if (!responses?.length) {
    // Never score 0/0 as 0%: the candidate never saw a question.
    if (await voidEmptyAttempt(admin, attemptId)) return null;
  }
  const score = scoreQuiz(responses ?? [], Number(app.roles.quiz_flag_pct), topicsFor(app.roles.slug));

  const { data, error } = await admin
    .from("quiz_attempts")
    .update({
      submitted_at: new Date().toISOString(),
      raw_score: score.rawScore,
      pct: score.pct,
      topic_scores: score.topicScores,
      below_flag: score.belowFlag,
    })
    .eq("id", attemptId)
    .is("submitted_at", null)
    .select(ATTEMPT_COLS);
  if (error && !error.message.includes("already_submitted")) throw new QuizError(error.message, 500);

  await settleApplication(admin, { id: app.id, stage: app.stage, status: app.status });
  await refreshQuietly(refreshScores(admin, [app.id]));
  if (data?.[0]) return data[0] as AttemptRow;
  // Someone else finalised it first.
  const { data: row } = await admin.from("quiz_attempts").select(ATTEMPT_COLS).eq("id", attemptId).maybeSingle();
  return (row as AttemptRow | null) ?? null;
}

/**
 * Deletes an unsubmitted attempt that has no rows (the candidate never saw a question), so
 * it can be rebuilt instead of being scored. Returns false if it has rows after all.
 */
async function voidEmptyAttempt(admin: SupabaseClient, attemptId: string): Promise<boolean> {
  const { count, error } = await admin
    .from("quiz_responses")
    .select("position", { count: "exact", head: true })
    .eq("attempt_id", attemptId);
  if (error) throw new QuizError(error.message, 500);
  if (count) return false;
  const { error: dErr } = await admin.from("quiz_attempts").delete().eq("id", attemptId).is("submitted_at", null);
  if (dErr) throw new QuizError(dErr.message, 500);
  console.warn(`quiz: voided empty attempt ${attemptId}`);
  return true;
}

/** A finished quiz leaves the application waiting for an admin. Never advances or rejects. */
async function settleApplication(admin: SupabaseClient, app: AppRow) {
  if (app.stage !== "quiz" || !SETTLE_STATUSES.includes(app.status)) return;
  const { error } = await admin
    .from("applications")
    .update({ status: "awaiting_review" })
    .eq("id", app.id)
    .eq("stage", "quiz")
    .eq("status", app.status);
  if (error) throw new QuizError(error.message, 500);
  app.status = "awaiting_review";
}

/**
 * Finalises every unsubmitted attempt whose deadline (plus grace) has passed, optionally only
 * for one user or one application. Used by the cron sweep (/api/cron/sweep) and
 * lazily by the results page and the admin quiz panel. Returns how many were finalised.
 */
export async function finaliseExpiredQuizzes(
  admin: SupabaseClient,
  scope: { userId?: string; applicationId?: string } = {},
): Promise<number> {
  const cutoff = new Date(Date.now() - QUIZ_GRACE_MS).toISOString();
  let query = admin.from("quiz_attempts").select("id").is("submitted_at", null).is("locked_at", null).lt("deadline_at", cutoff);
  if (scope.userId) query = query.eq("user_id", scope.userId);
  if (scope.applicationId) query = query.eq("application_id", scope.applicationId);
  const { data, error } = await query.limit(500);
  if (error) throw new QuizError(error.message, 500);
  let finalised = 0;
  for (const a of data ?? []) if (await finaliseQuiz(admin, a.id)) finalised++;
  return finalised;
}

function done(a: AttemptRow): QuizState {
  return {
    status: "done",
    attemptId: a.id,
    result: {
      rawScore: a.raw_score ?? 0,
      total: a.item_count,
      pct: Number(a.pct ?? 0),
      topicScores: a.topic_scores ?? {},
      submittedAt: a.submitted_at ?? "",
    },
  };
}
