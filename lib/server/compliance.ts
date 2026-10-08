import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { inChunks } from "@/lib/server/query";
import { fourFifths, MIN_GROUP_SIZE, type FourFifthsRow } from "@/lib/stats/four-fifths";
import { kr20Band, kr20FromSummary } from "@/lib/stats/kr20";
import { utcDay } from "@/lib/stats/retention";

/**
 * Compliance reporting for /admin/compliance (docs/09 §9, docs/12). Every function takes the
 * admin's own client: RLS and the admin-only security-definer functions decide what comes back.
 * Demographics never leave the database as rows; only adverse_impact_report() and
 * demographics_coverage() aggregate them, with groups under 30 suppressed.
 */

export const REPORT_STAGES = ["interview", "quiz", "work_1", "work_2", "grading", "shortlist", "live", "offer"] as const;
export type ReportStage = (typeof REPORT_STAGES)[number];
export const DIMENSIONS = ["population_group", "gender", "disability"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DIMENSION_LABEL: Record<Dimension, string> = {
  population_group: "Population group",
  gender: "Gender",
  disability: "Disability",
};

export const GROUP_LABEL: Record<string, string> = {
  african: "African",
  coloured: "Coloured",
  indian: "Indian",
  white: "White",
  other: "Other",
  female: "Female",
  male: "Male",
  non_binary: "Non-binary",
  yes: "Disability",
  no: "No disability",
  prefer_not: "Prefer not to say",
  not_disclosed: "Not disclosed",
};

/**
 * A cohort is a whole calendar month of application (UTC) and/or a role (a hiring round), never
 * a free date range: two windows a day apart could be subtracted to reveal one person's group.
 */
export const CohortFilter = z.object({
  role: z.string().regex(/^[a-z0-9-]+$/).optional().catch(undefined),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional()
    .catch(undefined),
});
export type CohortFilter = z.infer<typeof CohortFilter>;

const ImpactRow = z.object({
  grp: z.string(),
  candidates: z.coerce.number(),
  advanced: z.coerce.number(),
  rate: z.coerce.number(),
});

export type ImpactReport = {
  stage: ReportStage;
  dimension: Dimension;
  /**
   * Groups with at least 30 decided applications, with rates, impact ratios and flags. Smaller
   * groups are never returned, named or counted, and nothing is returned at all when a shown
   * group's complement in the cohort is under 30 (see adverse_impact_report in migration 0018).
   */
  rows: FourFifthsRow[];
  reference: { group: string; rate: number } | null;
  flagged: string[];
  /** Decided applications across the shown groups (not the cohort's total). */
  decided: number;
};

/** Advance rates by group at one stage, with the four-fifths check. */
export async function adverseImpact(supabase: SupabaseClient, stage: ReportStage, dimension: Dimension, filter: CohortFilter = {}): Promise<ImpactReport> {
  const { data, error } = await supabase.rpc("adverse_impact_report", {
    p_stage: stage,
    p_dimension: dimension,
    p_min_n: MIN_GROUP_SIZE,
    p_cohort_month: filter.month ? `${filter.month}-01` : null,
    p_role_slug: filter.role ?? null,
  });
  if (error) throw new Error(`adverse_impact_report: ${error.message}`);
  const shown = z.array(ImpactRow).parse(data ?? []);
  const result = fourFifths(shown.map((r) => ({ group: r.grp, candidates: r.candidates, advanced: r.advanced })));
  return {
    stage,
    dimension,
    rows: result.rows,
    reference: result.reference,
    flagged: result.flagged,
    decided: shown.reduce((a, r) => a + r.candidates, 0),
  };
}

/** Every stage × dimension for one cohort. */
export async function adverseImpactAll(supabase: SupabaseClient, filter: CohortFilter = {}): Promise<ImpactReport[]> {
  const jobs = REPORT_STAGES.flatMap((stage) => DIMENSIONS.map((dimension) => adverseImpact(supabase, stage, dimension, filter)));
  return Promise.all(jobs);
}

const Kr20Input = z.object({
  form: z.string(),
  cohort: z.string().nullable(),
  attempts: z.coerce.number(),
  k: z.coerce.number(),
  sum_pq: z.coerce.number().nullable(),
  var_total: z.coerce.number().nullable(),
  mean_total: z.coerce.number().nullable(),
});

export type ReliabilityRow = {
  form: string;
  /** First day of the cohort month, or null for all months together. */
  cohort: string | null;
  attempts: number;
  k: number;
  mean: number | null;
  kr20: number | null;
  band: ReturnType<typeof kr20Band>;
};

/** KR-20 for the reasoning test per form and cohort month (live responses plus the archive). */
export async function reliability(supabase: SupabaseClient): Promise<ReliabilityRow[]> {
  const { data, error } = await supabase.rpc("reasoning_kr20_inputs");
  if (error) throw new Error(`reasoning_kr20_inputs: ${error.message}`);
  return z
    .array(Kr20Input)
    .parse(data ?? [])
    .map((r) => {
      const value = r.sum_pq === null || r.var_total === null ? null : kr20FromSummary({ k: r.k, sumPQ: r.sum_pq, variance: r.var_total });
      return { form: r.form, cohort: r.cohort, attempts: r.attempts, k: r.k, mean: r.mean_total, kr20: value, band: kr20Band(value, r.attempts) };
    });
}

const CoverageRow = z.object({
  candidates: z.coerce.number(),
  respondents: z.coerce.number(),
  dimension: z.enum(DIMENSIONS),
  disclosed: z.coerce.number(),
  prefer_not: z.coerce.number(),
  not_answered: z.coerce.number(),
});

export type Coverage = {
  candidates: number;
  respondents: number;
  dimensions: { dimension: Dimension; disclosed: number; preferNot: number; notAnswered: number }[];
};

/** How many candidates filled in the optional form (aggregates only). */
export async function demographicsCoverage(supabase: SupabaseClient): Promise<Coverage> {
  const { data, error } = await supabase.rpc("demographics_coverage");
  if (error) throw new Error(`demographics_coverage: ${error.message}`);
  const rows = z.array(CoverageRow).parse(data ?? []);
  return {
    candidates: rows[0]?.candidates ?? 0,
    respondents: rows[0]?.respondents ?? 0,
    dimensions: rows.map((r) => ({ dimension: r.dimension, disclosed: r.disclosed, preferNot: r.prefer_not, notAnswered: r.not_answered })),
  };
}

export type QueueEntry = { userId: string; name: string; purgeAfter: string; reason: string; basisAt: string | null };
export type PurgeLogEntry = { id: string; hash: string; purgedAt: string; scope: string; detail: Record<string, unknown> };
export type InProgressPurge = { userId: string; hash: string; startedAt: string; attempts: number; lastError: string | null; step: string };

export type RetentionOverview = {
  today: string;
  queued: number;
  dueNow: number;
  dueIn30Days: number;
  talentPool: number;
  next: QueueEntry[];
  log: PurgeLogEntry[];
  inProgress: InProgressPurge[];
  openReviewRequests: number;
};

async function count(q: PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<number> {
  const { count: n, error } = await q;
  if (error) throw new Error(error.message);
  return n ?? 0;
}

/** The retention queue (who and when), recent purges and purges still in progress. */
export async function retentionOverview(supabase: SupabaseClient, opts: { now?: Date; limit?: number } = {}): Promise<RetentionOverview> {
  const now = opts.now ?? new Date();
  const today = utcDay(now);
  const in30 = utcDay(new Date(now.getTime() + 30 * 86_400_000));
  const head = { count: "exact" as const, head: true };
  const [queued, dueNow, dueIn30Days, talentPool, openReviewRequests, nextRes, logRes, progRes] = await Promise.all([
    count(supabase.from("retention_queue").select("user_id", head)),
    count(supabase.from("retention_queue").select("user_id", head).lte("purge_after", today)),
    count(supabase.from("retention_queue").select("user_id", head).lte("purge_after", in30)),
    count(supabase.from("retention_queue").select("user_id", head).like("reason", "Talent pool%")),
    count(supabase.from("review_requests").select("id", head).eq("status", "open")),
    supabase.from("retention_queue").select("user_id, purge_after, reason, basis_at").order("purge_after").order("user_id").limit(opts.limit ?? 100),
    supabase.from("purge_log").select("id, user_id_hash, purged_at, scope, detail").order("purged_at", { ascending: false }).limit(50),
    supabase.from("retention_purges").select("user_id, user_id_hash, started_at, attempts, last_error, storage_done_at, auth_deleted_at").order("started_at"),
  ]);
  for (const r of [nextRes, logRes, progRes]) if (r.error) throw new Error(r.error.message);
  const next = (nextRes.data ?? []) as { user_id: string; purge_after: string; reason: string; basis_at: string | null }[];
  const names = await profileNames(supabase, next.map((r) => r.user_id));
  return {
    today,
    queued,
    dueNow,
    dueIn30Days,
    talentPool,
    openReviewRequests,
    next: next.map((r) => ({ userId: r.user_id, name: names.get(r.user_id) ?? r.user_id.slice(0, 8), purgeAfter: r.purge_after, reason: r.reason, basisAt: r.basis_at })),
    log: (logRes.data ?? []).map((r) => ({
      id: r.id as string,
      hash: r.user_id_hash as string,
      purgedAt: r.purged_at as string,
      scope: r.scope as string,
      detail: (r.detail ?? {}) as Record<string, unknown>,
    })),
    inProgress: (progRes.data ?? []).map((r) => ({
      userId: r.user_id as string,
      hash: r.user_id_hash as string,
      startedAt: r.started_at as string,
      attempts: r.attempts as number,
      lastError: (r.last_error as string | null) ?? null,
      step: r.auth_deleted_at
        ? r.storage_done_at
          ? "account and files deleted; checking and writing the log"
          : "account deleted; deleting files"
        : "decisions archived; account still to delete",
    })),
  };
}

const StaleRow = z.object({
  application_id: z.string(),
  user_id: z.string(),
  role_slug: z.string().nullable(),
  stage: z.string(),
  status: z.string(),
  last_activity: z.string(),
  round_closed_at: z.string().nullable(),
  retention_from: z.string(),
});

export type StaleApplication = {
  applicationId: string;
  userId: string;
  name: string;
  role: string | null;
  stage: string;
  status: string;
  lastActivity: string;
  roundClosedAt: string | null;
  /** When retention treats it as ended (the 6/12-month clock starts then). */
  retentionFrom: string;
};

/**
 * Applications still in play with no activity for `months` (or on a role whose round has
 * closed): an admin should close them with a decision. Retention doesn't wait for that: an
 * application idle for 6 months counts as lapsed, and one on a closed round as ended.
 */
export async function staleApplications(supabase: SupabaseClient, months = 3): Promise<StaleApplication[]> {
  const { data, error } = await supabase.rpc("retention_stale_applications", { p_months: months });
  if (error) throw new Error(`retention_stale_applications: ${error.message}`);
  const rows = z.array(StaleRow).parse(data ?? []);
  const names = await profileNames(supabase, rows.map((r) => r.user_id));
  return rows.map((r) => ({
    applicationId: r.application_id,
    userId: r.user_id,
    name: names.get(r.user_id) ?? r.user_id.slice(0, 8),
    role: r.role_slug,
    stage: r.stage,
    status: r.status,
    lastActivity: r.last_activity,
    roundClosedAt: r.round_closed_at,
    retentionFrom: r.retention_from,
  }));
}

/** Former staff (no longer admins) named on decisions, scorecards etc.: the purge leaves them out. */
export async function formerStaffCount(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.rpc("retention_former_staff_count");
  if (error) throw new Error(`retention_former_staff_count: ${error.message}`);
  return Number(data ?? 0);
}

/** "Name · email" for admins (profiles are admin-readable). */
export async function profileNames(supabase: SupabaseClient, userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  const rows = await inChunks<{ user_id: string; full_name: string | null; email: string | null }>(ids, (c) =>
    supabase.from("profiles").select("user_id, full_name, email").in("user_id", c),
  );
  return new Map(rows.map((p) => [p.user_id, `${p.full_name || "(no name)"} · ${p.email ?? ""}`]));
}
