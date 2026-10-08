import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inChunks } from "@/lib/server/query";
import { assemblePanel, bankQuestions, normaliseConcerns, type BankQuestion, type Concern } from "@/lib/live/panel";
import { kindsForRole, viewerLiveScores, type LiveQuestion, type ScoredKind, type ScorecardKind, type ViewerLiveScores } from "@/lib/live/scorecard";
import type { Weighted } from "@/lib/scoring/composite";
import { assembleLiveForm, seedForApplication, stemKey } from "@/lib/live/retest";
import type { AssembledItem } from "@/lib/reasoning/blueprint";

/**
 * Live stage (docs/01 "live", docs/09 §2 and §5): data for the admin scorecards and the paper
 * reasoning retest. Reads that show scores go through the ADMIN'S OWN client, so RLS applies:
 * a rater sees other raters' scorecards for a kind only after submitting their own. The
 * service-role client is used only for counts (how many raters submitted), never for scores.
 */

export const LIVE_STAGES = ["shortlist", "live"] as const;

export class LiveError extends Error {}

export type LiveApplication = {
  id: string;
  user_id: string;
  stage: string;
  status: string;
  composite_score: number | null;
  final_score: number | null;
  live_delta: number | null;
  roles: { slug: string; title: string } | null;
};
const APP_COLS = "id, user_id, stage, status, composite_score, final_score, live_delta, roles(slug, title)";

export type Scorecard = {
  id: string;
  application_id: string;
  kind: ScorecardKind;
  rater: string;
  scores: Record<string, unknown>;
  total: number | null;
  notes: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
};
export const CARD_COLS = "id, application_id, kind, rater, scores, total, notes, submitted_at, created_at, updated_at";

export async function loadApplication(supabase: SupabaseClient, applicationId: string): Promise<LiveApplication | null> {
  const { data, error } = await supabase.from("applications").select(APP_COLS).eq("id", applicationId).maybeSingle<LiveApplication>();
  if (error) throw new LiveError(error.message);
  return data;
}

/** The candidate's latest AI-interview verification concerns and suggested live follow-ups (docs/05). */
export async function interviewConcerns(supabase: SupabaseClient, applicationId: string): Promise<{ concerns: Concern[]; followups: string[]; graded: boolean }> {
  const { data, error } = await supabase
    .from("interview_sessions")
    .select("summary, started_at")
    .eq("application_id", applicationId)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new LiveError(error.message);
  const summary = (data?.[0]?.summary ?? null) as { verification_concerns?: unknown; live_followups?: unknown } | null;
  const followups = Array.isArray(summary?.live_followups)
    ? summary.live_followups.filter((f): f is string => typeof f === "string" && f.trim().length > 0).map((f) => f.trim().slice(0, 400)).slice(0, 6)
    : [];
  return { concerns: normaliseConcerns(summary?.verification_concerns), followups, graded: Boolean(summary && "verification_concerns" in summary) };
}

type BankRow = { key: string; kind: string; position: number; text: string; probes: string[] | null; anchors: Record<string, string> | null; replaceable: boolean; active: boolean };

function toBank(r: BankRow): BankQuestion {
  const a = r.anchors ?? {};
  return {
    key: r.key,
    position: r.position,
    text: r.text,
    probes: r.probes ?? [],
    anchors: { "1": a["1"] ?? "", "3": a["3"] ?? "", "5": a["5"] ?? "" },
    replaceable: r.replaceable,
    active: r.active,
  };
}

/**
 * The questions on each scored card for this application: the role's bank per kind, with the
 * panel interview's two verification slots filled from the AI-interview concerns.
 */
export async function questionsFor(supabase: SupabaseClient, roleSlug: string, applicationId: string): Promise<{ byKind: Map<ScoredKind, LiveQuestion[]>; kinds: ScoredKind[]; concerns: Concern[]; followups: string[] }> {
  const kinds = kindsForRole(roleSlug);
  const [{ data, error }, interview] = await Promise.all([
    supabase.from("live_questions").select("key, kind, position, text, probes, anchors, replaceable, active").eq("role_slug", roleSlug).in("kind", kinds),
    interviewConcerns(supabase, applicationId),
  ]);
  if (error) throw new LiveError(error.message);
  const rows = (data ?? []) as BankRow[];
  const byKind = new Map<ScoredKind, LiveQuestion[]>();
  for (const kind of kinds) {
    const bank = rows.filter((r) => r.kind === kind).map(toBank);
    byKind.set(kind, kind === "panel_interview" ? assemblePanel(bank, interview.concerns) : bankQuestions(bank));
  }
  return { byKind, kinds, concerns: interview.concerns, followups: interview.followups };
}

/**
 * Scorecards this viewer may see: their own (drafts included), plus the other panellists'
 * SUBMITTED cards for a part once the viewer has submitted theirs. RLS enforces it (migration
 * 0019); the filter here is defence in depth, so another panellist's draft never reaches a page.
 */
export async function visibleScorecards(supabase: SupabaseClient, applicationId: string, viewerId: string): Promise<Scorecard[]> {
  const { data, error } = await supabase
    .from("live_scorecards")
    .select(CARD_COLS)
    .eq("application_id", applicationId)
    .or(`submitted_at.not.is.null,rater.eq.${viewerId}`)
    .order("created_at");
  if (error) throw new LiveError(error.message);
  return ((data ?? []) as Scorecard[])
    .filter((c) => c.rater === viewerId || c.submitted_at !== null)
    .map((c) => ({ ...c, total: c.total === null ? null : Number(c.total) }));
}

/**
 * Live and final scores as one panellist may see them, for many applications at once (docs/09 §5:
 * independent raters). Reads the cards through the VIEWER'S OWN client (RLS: their own cards, plus
 * the other panellists' submitted cards for a part once they have submitted theirs), chunked, and
 * applies viewerLiveScores: a part shows only after the viewer submitted it, the final only after
 * they submitted every part. For any page that shows live or final scores to an admin (candidate
 * page, pipeline board): never show computeScores(service).live / .final or applications.final_score
 * while the viewer hasn't submitted every part.
 */
export async function viewerLiveGate(
  viewerClient: SupabaseClient,
  viewerId: string,
  apps: readonly { applicationId: string; roleSlug: string; preLive: Weighted | null }[],
): Promise<Map<string, ViewerLiveScores>> {
  const cards = await inChunks<{ application_id: string; kind: string; rater: string; total: number | null; submitted_at: string | null }>(
    apps.map((a) => a.applicationId),
    (c) => viewerClient.from("live_scorecards").select("application_id, kind, rater, total, submitted_at").in("application_id", c),
  );
  const byApp = new Map<string, typeof cards>();
  for (const c of cards) byApp.set(c.application_id, [...(byApp.get(c.application_id) ?? []), { ...c, total: c.total === null ? null : Number(c.total) }]);
  return new Map(apps.map((a) => [a.applicationId, viewerLiveScores(a.roleSlug, byApp.get(a.applicationId) ?? [], viewerId, a.preLive)]));
}

export type RecordedRetest = {
  id: string;
  rater: string;
  raw: number | null;
  seed: number | null;
  livePercentile: number | null;
  onlinePercentile: number | null;
  delta: number | null;
  normVersion: string | null;
  submittedAt: string | null;
};

/**
 * The reasoning retest recorded for an application (one per application, DB guard), or null.
 * A retest is an objective count of correct answers, not a panellist's judgement, so every admin
 * sees it once it is recorded: read with the service role after the caller's admin check.
 */
export async function recordedRetest(admin: SupabaseClient, applicationId: string): Promise<RecordedRetest | null> {
  const { data, error } = await admin
    .from("live_scorecards")
    .select("id, rater, scores, total, submitted_at")
    .eq("application_id", applicationId)
    .eq("kind", "reasoning_retest")
    .order("created_at")
    .limit(1);
  if (error) throw new LiveError(error.message);
  const r = data?.[0];
  if (!r) return null;
  const s = (r.scores ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    id: r.id as string,
    rater: r.rater as string,
    raw: n(s.raw),
    seed: n(s.seed),
    livePercentile: r.total === null ? null : Number(r.total),
    onlinePercentile: n(s.online_percentile),
    delta: n(s.delta),
    normVersion: typeof s.norm_version === "string" ? s.norm_version : null,
    submittedAt: (r.submitted_at as string | null) ?? null,
  };
}

export type KindCount = { submitted: number; drafts: number; mine: "submitted" | "draft" | null };

/** Per application and kind: how many raters submitted / have drafts, and the viewer's own state. No scores. */
export async function scorecardCounts(admin: SupabaseClient, applicationIds: readonly string[], viewerId: string): Promise<Map<string, Map<string, KindCount>>> {
  const rows = await inChunks<{ application_id: string; kind: string; rater: string; submitted_at: string | null }>(applicationIds, (c) =>
    admin.from("live_scorecards").select("application_id, kind, rater, submitted_at").in("application_id", c),
  );
  const out = new Map<string, Map<string, KindCount>>();
  for (const r of rows) {
    const byKind = out.get(r.application_id) ?? new Map<string, KindCount>();
    const k = byKind.get(r.kind) ?? { submitted: 0, drafts: 0, mine: null };
    if (r.submitted_at) k.submitted++;
    else k.drafts++;
    if (r.rater === viewerId) k.mine = r.submitted_at ? "submitted" : "draft";
    byKind.set(r.kind, k);
    out.set(r.application_id, byKind);
  }
  return out;
}

/** Applications at the shortlist or live stage, newest activity first, with names. */
export async function liveApplications(supabase: SupabaseClient, opts: { role?: string } = {}): Promise<(LiveApplication & { name: string; email: string })[]> {
  const { data, error } = await supabase
    .from("applications")
    .select(APP_COLS)
    .in("stage", [...LIVE_STAGES])
    .order("updated_at", { ascending: false })
    .limit(1000)
    .returns<LiveApplication[]>();
  if (error) throw new LiveError(error.message);
  const apps = (data ?? []).filter((a) => !opts.role || a.roles?.slug === opts.role);
  const profiles = await inChunks<{ user_id: string; full_name: string | null; email: string | null }>([...new Set(apps.map((a) => a.user_id))], (c) =>
    supabase.from("profiles").select("user_id, full_name, email").in("user_id", c),
  );
  const who = new Map(profiles.map((p) => [p.user_id, p]));
  return apps.map((a) => ({ ...a, name: who.get(a.user_id)?.full_name || "(no name)", email: who.get(a.user_id)?.email ?? "" }));
}

/** Display names for raters (profiles; falls back to a short id). */
export async function raterNames(admin: SupabaseClient, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const rows = await inChunks<{ user_id: string; full_name: string | null; email: string | null }>(unique, (c) =>
    admin.from("profiles").select("user_id, full_name, email").in("user_id", c),
  );
  const m = new Map(rows.map((r) => [r.user_id, r.full_name || r.email || ""]));
  return new Map(unique.map((id) => [id, m.get(id) || `rater ${id.slice(0, 8)}`]));
}

// ───────────────────────── Reasoning retest ─────────────────────────

/** The candidate's latest submitted ONLINE reasoning attempt (the one the composite uses). */
export async function onlineReasoning(supabase: SupabaseClient, userId: string): Promise<{ id: string; percentile: number | null; raw_score: number | null; stars: number | null; norm_version: string | null } | null> {
  const { data, error } = await supabase
    .from("reasoning_attempts")
    .select("id, percentile, raw_score, stars, norm_version, started_at")
    .eq("user_id", userId)
    .eq("form", "online")
    .not("submitted_at", "is", null)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new LiveError(error.message);
  const a = data?.[0];
  return a ? { id: a.id, percentile: a.percentile === null ? null : Number(a.percentile), raw_score: a.raw_score, stars: a.stars, norm_version: a.norm_version } : null;
}

/**
 * The printable parallel form for one candidate: 12 items from the active form='live' templates,
 * seeded per candidate, with any stem the candidate saw online re-seeded away.
 */
export async function retestForm(supabase: SupabaseClient, userId: string, seed: number): Promise<AssembledItem[]> {
  const [{ data: templates, error: tErr }, { data: attempts, error: aErr }] = await Promise.all([
    supabase.from("reasoning_items").select("family, tier").eq("form", "live").eq("active", true),
    supabase.from("reasoning_attempts").select("id").eq("user_id", userId).eq("form", "online"),
  ]);
  if (tErr || aErr) throw new LiveError((tErr ?? aErr)!.message);
  if (!templates?.length) throw new LiveError("The live reasoning pool has no active templates (migration 0017).");
  const seen = await inChunks<{ rendered: { stem?: AssembledItem["stem"] } | null }>((attempts ?? []).map((a) => a.id as string), (c) =>
    supabase.from("reasoning_responses").select("rendered").in("attempt_id", c),
  );
  const exclude = new Set(seen.map((r) => (r.rendered?.stem ? stemKey(r.rendered.stem) : "")).filter(Boolean));
  return assembleLiveForm(seed, { available: new Set(templates.map((t) => `${t.family}:${t.tier}`)), exclude });
}

/** Seed for the printed form: ?seed= when given, else the one already recorded, else a stable per-application seed. */
export function chooseSeed(applicationId: string, requested: string | undefined, recorded: number | null): number {
  const n = requested !== undefined && /^\d{1,10}$/.test(requested) ? Number(requested) : NaN;
  if (Number.isInteger(n) && n > 0 && n < 2 ** 31) return n;
  return recorded ?? seedForApplication(applicationId);
}
