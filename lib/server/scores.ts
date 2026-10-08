import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  EXEC_COMMS_KEYS,
  execCommsScore,
  finalComposite,
  liveComposite,
  liveParts,
  preLiveComposite,
  type Components,
  type PreLiveKey,
  type Weighted,
} from "@/lib/scoring/composite";
import { all, inChunks } from "@/lib/server/query";

/**
 * Per-application scores and flags for the admin pipeline (docs/09 §2). Reads with the
 * service-role client after an admin check by the caller. Scores sort and flag; people decide.
 */

export interface AppScore {
  applicationId: string;
  userId: string;
  roleSlug: string;
  roleTitle: string;
  stage: string;
  status: string;
  createdAt: string;
  belowHurdle: boolean;
  reasoningStars: number | null;
  parts: Components<PreLiveKey>;
  preLive: Weighted;
  live: Weighted;
  final: number | null;
  execComms: { score: number | null; n: number };
  liveDelta: number | null;
  flags: {
    openDedupe: number;
    openReviewRequests: number;
    gradesNeedingReview: number;
    lockedSessions: number;
    injectionSignals: number;
    /** Things a person should check on work submissions (submissions.review_flags). */
    submissionFlags: number;
  };
}

type AppRow = {
  id: string;
  user_id: string;
  stage: string;
  status: string;
  created_at: string;
  below_hurdle: boolean;
  reasoning_stars: number | null;
  live_delta: number | null;
  roles: { slug: string; title: string } | null;
};

const count = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);

export async function computeScores(admin: SupabaseClient, opts: { applicationIds?: readonly string[] } = {}): Promise<AppScore[]> {
  const cols = "id, user_id, stage, status, created_at, below_hurdle, reasoning_stars, live_delta, roles(slug, title)";
  const apps = opts.applicationIds
    ? await inChunks<AppRow>(opts.applicationIds, (c) => admin.from("applications").select(cols).in("id", c).returns<AppRow[]>())
    : await all<AppRow>((f, t) => admin.from("applications").select(cols).order("created_at").range(f, t).returns<AppRow[]>());
  if (!apps.length) return [];
  const appIds = apps.map((a) => a.id);
  const userIds = [...new Set(apps.map((a) => a.user_id))];

  const [reasoning, sessions, quizzes, work, cards, dedupe, reviews, signals] = await Promise.all([
    inChunks<{ user_id: string; percentile: number | null; started_at: string; locked_at: string | null; submitted_at: string | null }>(userIds, (c) =>
      admin.from("reasoning_attempts").select("user_id, percentile, started_at, locked_at, submitted_at").eq("form", "online").in("user_id", c),
    ),
    inChunks<{ id: string; application_id: string; score: number | null; locked_at: string | null }>(appIds, (c) =>
      admin.from("interview_sessions").select("id, application_id, score, locked_at").in("application_id", c),
    ),
    inChunks<{ application_id: string; pct: number | null; submitted_at: string | null; locked_at: string | null }>(appIds, (c) =>
      admin.from("quiz_attempts").select("application_id, pct, submitted_at, locked_at").in("application_id", c),
    ),
    inChunks<{ application_id: string; work_stages: { app_stage: string } | null; submissions: { id: string; score: number | null; review_flags: unknown[] | null } | null }>(appIds, (c) =>
      admin
        .from("work_attempts")
        .select("application_id, work_stages(app_stage), submissions(id, score, review_flags)")
        .in("application_id", c)
        .returns<{ application_id: string; work_stages: { app_stage: string } | null; submissions: { id: string; score: number | null; review_flags: unknown[] | null } | null }[]>(),
    ),
    inChunks<{ application_id: string; kind: string; total: number | null; submitted_at: string | null }>(appIds, (c) =>
      admin.from("live_scorecards").select("application_id, kind, total, submitted_at").in("application_id", c),
    ),
    inChunks<{ user_id: string; matched_user_id: string }>(userIds, (c) =>
      admin.from("dedupe_flags").select("user_id, matched_user_id").eq("status", "open").or(`user_id.in.(${c.join(",")}),matched_user_id.in.(${c.join(",")})`),
    ),
    inChunks<{ user_id: string }>(userIds, (c) => admin.from("review_requests").select("user_id").eq("status", "open").in("user_id", c)),
    inChunks<{ user_id: string }>(userIds, (c) => admin.from("signals").select("user_id").eq("kind", "prompt_injection").in("user_id", c)),
  ]);

  // Grade summaries for this set's interview sessions and submissions: exec comms + review flags.
  const subjectApp = new Map<string, string>();
  for (const s of sessions) subjectApp.set(s.id, s.application_id);
  for (const w of work) if (w.submissions?.id) subjectApp.set(w.submissions.id, w.application_id);
  const grades = await inChunks<{ subject_id: string; criterion_key: string; final_score: number | null; needs_human_review: boolean; human_score: number | null }>(
    [...subjectApp.keys()],
    (c) => admin.from("grade_summaries").select("subject_id, criterion_key, final_score, needs_human_review, human_score").in("subject_id", c),
  );

  const latestReasoning = new Map<string, { percentile: number | null; started_at: string }>();
  const lockedReasoning = new Map<string, number>();
  for (const r of reasoning) {
    if (r.locked_at && !r.submitted_at) count(lockedReasoning, r.user_id);
    if (!r.submitted_at) continue;
    const prev = latestReasoning.get(r.user_id);
    if (!prev || r.started_at > prev.started_at) latestReasoning.set(r.user_id, r);
  }
  const sessionBy = new Map(sessions.map((s) => [s.application_id, s]));
  const quizBy = new Map(quizzes.map((q) => [q.application_id, q]));
  const workBy = new Map<string, Partial<Record<"work_1" | "work_2", number | null>>>();
  const submissionFlagsBy = new Map<string, number>();
  for (const w of work) {
    const n = Array.isArray(w.submissions?.review_flags) ? w.submissions.review_flags.length : 0;
    if (n) submissionFlagsBy.set(w.application_id, (submissionFlagsBy.get(w.application_id) ?? 0) + n);
    const st = w.work_stages?.app_stage;
    if (st !== "work_1" && st !== "work_2") continue;
    workBy.set(w.application_id, { ...workBy.get(w.application_id), [st]: w.submissions?.score ?? null });
  }
  const cardsBy = new Map<string, { kind: string; total: number | null; submitted: boolean }[]>();
  for (const c of cards) cardsBy.set(c.application_id, [...(cardsBy.get(c.application_id) ?? []), { kind: c.kind, total: c.total === null ? null : Number(c.total), submitted: !!c.submitted_at }]);
  const dedupeBy = new Map<string, number>();
  for (const d of dedupe) {
    count(dedupeBy, d.user_id);
    if (d.matched_user_id !== d.user_id) count(dedupeBy, d.matched_user_id);
  }
  const reviewsBy = new Map<string, number>();
  for (const r of reviews) count(reviewsBy, r.user_id);
  const injectionsBy = new Map<string, number>();
  for (const s of signals) count(injectionsBy, s.user_id);
  const commsBy = new Map<string, number[]>();
  const needsReviewBy = new Map<string, number>();
  for (const g of grades) {
    const app = subjectApp.get(g.subject_id);
    if (!app) continue;
    if (g.needs_human_review && g.human_score === null) count(needsReviewBy, app);
    if (EXEC_COMMS_KEYS.includes(g.criterion_key) && g.final_score !== null) commsBy.set(app, [...(commsBy.get(app) ?? []), Number(g.final_score)]);
  }

  const num = (v: number | null | undefined) => (v === null || v === undefined ? null : Number(v));
  return apps.map((a) => {
    const roleSlug = a.roles?.slug ?? "";
    const session = sessionBy.get(a.id);
    const quiz = quizBy.get(a.id);
    const w = workBy.get(a.id) ?? {};
    const parts: Components<PreLiveKey> = {
      reasoning: num(latestReasoning.get(a.user_id)?.percentile),
      interview: num(session?.score),
      quiz: quiz?.submitted_at ? num(quiz.pct) : null,
      work_1: num(w.work_1),
      work_2: num(w.work_2),
    };
    const preLive = preLiveComposite(roleSlug, parts);
    const live = liveComposite(roleSlug, liveParts(cardsBy.get(a.id) ?? []));
    const locked =
      (lockedReasoning.get(a.user_id) ?? 0) + (session?.locked_at ? 1 : 0) + (quiz?.locked_at && !quiz.submitted_at ? 1 : 0);
    return {
      applicationId: a.id,
      userId: a.user_id,
      roleSlug,
      roleTitle: a.roles?.title ?? "",
      stage: a.stage,
      status: a.status,
      createdAt: a.created_at,
      belowHurdle: a.below_hurdle,
      reasoningStars: a.reasoning_stars,
      parts,
      preLive,
      live,
      final: finalComposite(preLive, live),
      execComms: execCommsScore(commsBy.get(a.id) ?? []),
      liveDelta: num(a.live_delta),
      flags: {
        openDedupe: dedupeBy.get(a.user_id) ?? 0,
        openReviewRequests: reviewsBy.get(a.user_id) ?? 0,
        gradesNeedingReview: needsReviewBy.get(a.id) ?? 0,
        lockedSessions: locked,
        injectionSignals: injectionsBy.get(a.user_id) ?? 0,
        submissionFlags: submissionFlagsBy.get(a.id) ?? 0,
      },
    };
  });
}

/**
 * Stores composite_score (pre-live) and final_score on applications. Called after scoring
 * events and by the daily sweep. Returns the number of rows changed.
 */
export async function refreshScores(admin: SupabaseClient, applicationIds?: readonly string[]): Promise<number> {
  const scores = await computeScores(admin, { applicationIds });
  const ids = scores.map((s) => s.applicationId);
  const current = await inChunks<{ id: string; composite_score: number | null; final_score: number | null }>(ids, (c) =>
    admin.from("applications").select("id, composite_score, final_score").in("id", c),
  );
  const now = new Map(current.map((c) => [c.id, c]));
  let changed = 0;
  for (const s of scores) {
    const cur = now.get(s.applicationId);
    const same = (a: number | null | undefined, b: number | null) => (a === null || a === undefined ? b === null : b !== null && Number(a) === b);
    if (cur && same(cur.composite_score, s.preLive.score) && same(cur.final_score, s.final)) continue;
    const { error } = await admin
      .from("applications")
      .update({ composite_score: s.preLive.score, final_score: s.final })
      .eq("id", s.applicationId);
    if (error) throw new Error(error.message);
    changed++;
  }
  return changed;
}

/** Refreshes the application a graded subject (interview session or submission) belongs to. */
export async function refreshScoresForSubject(admin: SupabaseClient, subjectType: string, subjectId: string): Promise<void> {
  let applicationId: string | null = null;
  if (subjectType === "interview") {
    const { data } = await admin.from("interview_sessions").select("application_id").eq("id", subjectId).maybeSingle();
    applicationId = data?.application_id ?? null;
  } else if (subjectType === "submission") {
    const { data } = await admin
      .from("submissions")
      .select("work_attempts(application_id)")
      .eq("id", subjectId)
      .maybeSingle<{ work_attempts: { application_id: string } | null }>();
    applicationId = data?.work_attempts?.application_id ?? null;
  }
  if (applicationId) await refreshScores(admin, [applicationId]);
}

/** Never lets a score refresh fail the scoring event that triggered it (the daily sweep retries). */
export function refreshQuietly(p: Promise<unknown>): Promise<void> {
  return p.then(
    () => undefined,
    (e) => console.error("score refresh failed", e instanceof Error ? e.message : e),
  );
}
