import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chatJson } from "@/lib/ai/openrouter";
import { CandidateBrief } from "@/lib/briefs/schema";
import { serverEnv } from "@/lib/config";
import { requirementsFor } from "@/lib/interview/requirements";
import { loadPrompt } from "@/lib/prompts";
import { wrapUntrusted } from "@/lib/sanitise";
import { computeScores } from "@/lib/server/scores";

/**
 * The AI candidate brief for admins: who the person is, strengths and concerns with evidence,
 * and an advisory recommendation per application. It reads only what the platform already holds
 * (parsed CV, scores, grader feedback, flags, decisions), never the candidate's name or contact
 * details, and never changes an application. Rebuilt when its inputs change.
 */

const PROMPT = { key: "candidate-brief", version: 1 } as const;

type Json = Record<string, unknown>;

export interface StoredBrief {
  content: CandidateBrief;
  model: string;
  promptVersion: string;
  createdAt: string;
  /** New results since the brief was written. */
  stale: boolean;
}

const one = <T>(rows: T[] | null | undefined): T | null => rows?.[0] ?? null;

/** Everything the brief is written from, without names or contact details. */
export async function briefInputs(admin: SupabaseClient, userId: string): Promise<Json> {
  const [cvRes, reasoningRes, appsRes, signalsRes] = await Promise.all([
    admin.from("cvs").select("parsed").eq("user_id", userId).eq("status", "parsed").order("created_at", { ascending: false }).limit(1),
    admin
      .from("reasoning_attempts")
      .select("stars, percentile, raw_score, submitted_at")
      .eq("user_id", userId)
      .not("submitted_at", "is", null)
      .order("started_at", { ascending: false })
      .limit(1),
    admin
      .from("applications")
      .select("id, stage, status, below_hurdle, created_at, roles(slug, title), decisions(decision, reason, stage, decided_at)")
      .eq("user_id", userId)
      .order("created_at"),
    admin.from("signals").select("kind").eq("user_id", userId).limit(1000),
  ]);
  for (const r of [cvRes, reasoningRes, appsRes, signalsRes]) if (r.error) throw new Error(r.error.message);

  const parsed = (one(cvRes.data)?.parsed ?? null) as Json | null;
  // Identity and contact links are left out: the brief is about the work, not the person's details.
  const cv = parsed ? { roles: parsed.roles ?? [], skills: parsed.skills ?? [], education: parsed.education ?? [], summary: parsed.summary ?? null } : null;
  const reasoning = one(reasoningRes.data);

  const signalCounts: Record<string, number> = {};
  for (const s of signalsRes.data ?? []) signalCounts[s.kind as string] = (signalCounts[s.kind as string] ?? 0) + 1;

  type AppRow = {
    id: string;
    stage: string;
    status: string;
    below_hurdle: boolean;
    created_at: string;
    roles: { slug: string; title: string } | null;
    decisions: { decision: string; reason: string; stage: string; decided_at: string }[] | null;
  };
  const apps = (appsRes.data ?? []) as unknown as AppRow[];
  const scores = apps.length ? await computeScores(admin, { applicationIds: apps.map((a) => a.id) }) : [];
  const scoreOf = new Map(scores.map((s) => [s.applicationId, s]));

  const applications = await Promise.all(
    apps.map(async (a) => {
      const [iv, quiz, attempts] = await Promise.all([
        admin.from("interview_sessions").select("score, end_reason, ended_at, summary").eq("application_id", a.id).maybeSingle(),
        admin.from("quiz_attempts").select("pct, topic_scores, submitted_at").eq("application_id", a.id).maybeSingle(),
        admin.from("work_attempts").select("id").eq("application_id", a.id),
      ]);
      const attemptIds = (attempts.data ?? []).map((x) => x.id as string);
      const subs = attemptIds.length
        ? (await admin.from("submissions").select("id, stage_key, score, grading_status, created_at, review_flags").in("attempt_id", attemptIds)).data ?? []
        : [];
      const work = await Promise.all(
        subs.map(async (s) => {
          const { data: g } = await admin
            .from("grade_summaries")
            .select("criterion_key, final_score, needs_human_review, feedback")
            .eq("subject_type", "submission")
            .eq("subject_id", s.id)
            .order("criterion_key");
          return {
            stage: s.stage_key,
            score: s.score,
            grading_status: s.grading_status,
            submitted_at: s.created_at,
            review_flags: s.review_flags ?? [],
            criteria: (g ?? [])
              .filter((x) => !String(x.criterion_key).includes("."))
              .map((x) => ({ key: x.criterion_key, score: x.final_score, under_review: x.needs_human_review, feedback: x.feedback })),
          };
        }),
      );
      const summary = (iv.data?.summary ?? null) as Json | null;
      const sc = scoreOf.get(a.id);
      return {
        role: a.roles?.title ?? null,
        role_slug: a.roles?.slug ?? null,
        stage: a.stage,
        status: a.status,
        below_reasoning_hurdle: a.below_hurdle,
        composite: sc ? { pre_live: sc.preLive.score, coverage: sc.preLive.coverage, missing: sc.preLive.missing, live: sc.live.score } : null,
        flags: sc?.flags ?? null,
        interview: iv.data
          ? {
              score: iv.data.score,
              ended: iv.data.ended_at ? (iv.data.end_reason as string) : "in progress",
              criteria: ((summary?.criteria as Json[] | undefined) ?? []).map((c) => ({
                key: c.key,
                title: c.title,
                score: c.final_score,
                under_review: c.needs_human_review,
                feedback: c.feedback,
              })),
              verification_concerns: summary?.verification_concerns ?? [],
              suggested_live_questions: summary?.live_followups ?? [],
            }
          : null,
        quiz: quiz.data?.submitted_at ? { pct: quiz.data.pct, topics: quiz.data.topic_scores } : null,
        work,
        decisions: (a.decisions ?? []).map((d) => ({ stage: d.stage, decision: d.decision, reason: d.reason, at: d.decided_at })),
      };
    }),
  );

  const roles = Object.fromEntries(
    [...new Set(apps.map((a) => a.roles?.slug).filter((s): s is string => !!s))].map((slug) => [slug, requirementsFor(slug).map((r) => r.text)]),
  );
  return {
    cv,
    reasoning: reasoning ? { stars: reasoning.stars, percentile: reasoning.percentile, correct_of_30: reasoning.raw_score } : null,
    applications,
    integrity_signals: signalCounts,
    roles,
  };
}

export function hashInputs(inputs: Json): string {
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}

export async function getBrief(admin: SupabaseClient, userId: string): Promise<StoredBrief | null> {
  const { data, error } = await admin.from("candidate_briefs").select("content, inputs_hash, model, prompt_version, created_at").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const content = CandidateBrief.safeParse(data.content);
  if (!content.success) return null;
  const current = hashInputs(await briefInputs(admin, userId));
  return { content: content.data, model: data.model, promptVersion: data.prompt_version, createdAt: data.created_at, stale: current !== data.inputs_hash };
}

/** Writes (or rewrites) the brief when its inputs changed; returns the current one. */
export async function generateBrief(admin: SupabaseClient, userId: string, adminId: string | null, opts: { force?: boolean } = {}): Promise<StoredBrief> {
  const inputs = await briefInputs(admin, userId);
  const hash = hashInputs(inputs);
  if (!opts.force) {
    const { data: existing } = await admin.from("candidate_briefs").select("inputs_hash").eq("user_id", userId).maybeSingle();
    if (existing?.inputs_hash === hash) {
      const b = await getBrief(admin, userId);
      if (b) return b;
    }
  }
  const prompt = loadPrompt(PROMPT.key, PROMPT.version);
  const res = await chatJson({
    model: serverEnv().OPENROUTER_MODEL_GRADER,
    system: prompt.system,
    user: wrapUntrusted("candidate", JSON.stringify(inputs)),
    schema: CandidateBrief,
    promptVersion: prompt.promptVersion,
    temperature: 0.2,
  });
  const row = {
    user_id: userId,
    content: res.data,
    inputs_hash: hash,
    model: res.model,
    prompt_version: res.promptVersion,
    created_by: adminId,
    created_at: new Date().toISOString(),
  };
  const { data: saved, error } = await admin.from("candidate_briefs").upsert(row, { onConflict: "user_id" }).select("created_at").single();
  if (error) throw new Error(error.message);
  return { content: res.data, model: res.model, promptVersion: res.promptVersion, createdAt: saved.created_at as string, stale: false };
}
