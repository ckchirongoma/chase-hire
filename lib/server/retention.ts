import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { all, inChunks } from "@/lib/server/query";
import { utcDay } from "@/lib/stats/retention";

/**
 * Retention purge (docs/12 §1 "Retention automation", the notice in lib/consent/notice.ts).
 *
 * The schedule lives in the database (public.retention_schedule; see migration
 * 20261007000018 for the rules): not appointed → 6 months after the application closed,
 * talent pool → 12 months, never admins, never anyone with an application in play or an open
 * review request. refreshRetentionQueue() mirrors it into retention_queue nightly.
 *
 * purgeDue() purges everyone whose date has arrived, one person at a time, in this order:
 *   1. retention_begin_purge (one transaction): re-check the rules, archive the decisions to
 *      decision_archive under sha256(user_id + RETENTION_PEPPER), archive the item responses to
 *      item_response_archive with no link to the person, delete their grades, and record the
 *      purge in retention_purges (which has no foreign key, so it outlives the auth user);
 *   2. delete their storage objects in every bucket ({user_id}/… everywhere, plus
 *      snapshots/{submission_id}/…), listed with pagination and checked empty afterwards;
 *   3. delete the auth user (cascades every table keyed by them, dedupe flags on both sides);
 *   4. retention_finish_purge: verify nothing keyed by them survived (any uuid column, any
 *      storage object), write purge_log and drop the state row.
 * Every step is idempotent and a purge that stopped halfway is resumed first on the next run.
 * The service-role client is required: call only from the cron sweep or after requireAdmin().
 */

const PAGE = 100;
const REMOVE_CHUNK = 100;
export const RETENTION_SWEEP_LIMIT = 25;
const TEST_PEPPER = "chase-hire-test-pepper-not-for-production";

export class RetentionError extends Error {
  constructor(
    message: string,
    public status = 500,
  ) {
    super(message);
  }
}

/** The server-only pepper for hashed ids. Required in production; a fixed fallback only under tests. */
export function retentionPepper(): string {
  const pepper = process.env.RETENTION_PEPPER;
  if (pepper && pepper.length >= 16) return pepper;
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return TEST_PEPPER;
  throw new RetentionError("RETENTION_PEPPER is not set (at least 16 characters, server-only). Purges are paused until it is.");
}

/** sha256(user_id + pepper), hex. The same person always maps to the same hash. */
export function hashUserId(userId: string, pepper: string = retentionPepper()): string {
  return createHash("sha256").update(userId + pepper).digest("hex");
}

/** Mirrors the schedule into retention_queue; returns how many people are queued. */
export async function refreshRetentionQueue(admin: SupabaseClient): Promise<number> {
  const { data, error } = await admin.rpc("refresh_retention_queue");
  if (error) throw new RetentionError(`refresh_retention_queue: ${error.message}`);
  return Number(data ?? 0);
}

// ───────────────────────── Storage ─────────────────────────

/** Every object path under `prefix` (recursive, a page at a time). */
export async function listObjects(admin: SupabaseClient, bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  const folders = [prefix];
  while (folders.length) {
    const dir = folders.pop()!;
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await admin.storage
        .from(bucket)
        .list(dir, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw new RetentionError(`could not list ${bucket}/${dir}: ${error.message}`);
      for (const entry of data ?? []) {
        if (!entry.name) continue;
        const path = `${dir}/${entry.name}`;
        // Folders come back without an id; placeholders and files have one.
        if (entry.id === null) folders.push(path);
        else out.push(path);
      }
      if (!data || data.length < PAGE) break;
    }
  }
  return out;
}

async function bucketIds(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin.storage.listBuckets();
  if (error) throw new RetentionError(`could not list buckets: ${error.message}`);
  return (data ?? []).map((b) => b.id).sort();
}

/**
 * Where a person's files live: {user_id}/ in every bucket (cvs, submissions, interview-audio,
 * and any bucket added later on the same convention) and snapshots/{submission_id}/.
 */
function storageTargets(buckets: string[], userId: string, submissionIds: readonly string[]): { bucket: string; prefix: string }[] {
  const targets = buckets.map((bucket) => ({ bucket, prefix: userId }));
  if (buckets.includes("snapshots")) for (const id of submissionIds) targets.push({ bucket: "snapshots", prefix: id });
  return targets;
}

async function inventory(admin: SupabaseClient, userId: string, submissionIds: readonly string[]) {
  const buckets = await bucketIds(admin);
  const found = new Map<string, string[]>();
  for (const t of storageTargets(buckets, userId, submissionIds)) {
    const paths = await listObjects(admin, t.bucket, t.prefix);
    if (paths.length) found.set(t.bucket, [...(found.get(t.bucket) ?? []), ...paths]);
  }
  return found;
}

/** Deletes every object of the person; checks the buckets are empty for them afterwards. */
async function clearStorage(admin: SupabaseClient, userId: string, submissionIds: readonly string[]): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  for (let pass = 0; pass < 3; pass++) {
    const found = await inventory(admin, userId, submissionIds);
    if (!found.size) return removed;
    for (const [bucket, paths] of found) {
      for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
        const chunk = paths.slice(i, i + REMOVE_CHUNK);
        const { error } = await admin.storage.from(bucket).remove(chunk);
        if (error) throw new RetentionError(`could not delete from ${bucket}: ${error.message}`);
        removed[bucket] = (removed[bucket] ?? 0) + chunk.length;
      }
    }
  }
  const left = await inventory(admin, userId, submissionIds);
  if (left.size) throw new RetentionError(`storage objects keep reappearing in ${[...left.keys()].join(", ")}`);
  return removed;
}

// ───────────────────────── Purge ─────────────────────────

const PurgeState = z.object({
  status: z.enum(["started", "resumed", "not_due", "not_eligible"]),
  user_id: z.string(),
  submission_ids: z.array(z.string()).nullish(),
  storage_done_at: z.string().nullish(),
  auth_deleted_at: z.string().nullish(),
  counts: z.record(z.string(), z.unknown()).nullish(),
  purge_after: z.string().nullish(),
});

const PreviewRow = z.object({
  user_id: z.string(),
  decisions: z.coerce.number(),
  reasoning_responses: z.coerce.number(),
  quiz_responses: z.coerce.number(),
  grades: z.coerce.number(),
  submission_ids: z.array(z.string()).nullable(),
});

export type PurgeOptions = {
  /** The clock (tests). Default: now. */
  now?: Date;
  /** Report what would be purged; change nothing. */
  dryRun?: boolean;
  /** At most this many people per call (the sweep's bound). Default 25. */
  limit?: number;
  /** Only these people (tests and targeted runs). */
  userIds?: readonly string[];
  /** Recorded in purge_log.detail. */
  triggeredBy?: string;
};

export type PlannedPurge = {
  userId: string;
  purgeAfter: string;
  reason: string;
  decisions: number;
  reasoningResponses: number;
  quizResponses: number;
  grades: number;
  storage: Record<string, number>;
};

export type PurgeOutcome =
  | { userIdHash: string; status: "purged"; resumed: boolean; purgeLogId: string | null; counts: Record<string, unknown> }
  | { userIdHash: string; status: "skipped"; reason: string }
  | { userIdHash: string; status: "failed"; error: string };

export type PurgeReport = {
  dryRun: boolean;
  today: string;
  /** People due (or still in progress) when the run started. */
  due: number;
  /** Purges that stopped halfway and are finished first (dry run: left for the next real run). */
  inProgress: number;
  planned: PlannedPurge[];
  outcomes: PurgeOutcome[];
  purged: number;
  failed: number;
  /** Due people left for the next run because of the limit. */
  remaining: number;
};

type DueRow = { user_id: string; purge_after: string; reason: string };

async function dueFromSchedule(admin: SupabaseClient, today: string, userIds?: readonly string[]): Promise<DueRow[]> {
  const { data, error } = await admin.rpc("retention_schedule", { p_user_ids: userIds ? [...userIds] : null });
  if (error) throw new RetentionError(`retention_schedule: ${error.message}`);
  return ((data ?? []) as DueRow[])
    .filter((r) => r.purge_after <= today)
    .sort((a, b) => a.purge_after.localeCompare(b.purge_after) || a.user_id.localeCompare(b.user_id));
}

async function dueFromQueue(admin: SupabaseClient, today: string, userIds?: readonly string[]): Promise<DueRow[]> {
  const cols = "user_id, purge_after, reason";
  const rows = userIds
    ? await inChunks<DueRow>([...userIds], (c) => admin.from("retention_queue").select(cols).lte("purge_after", today).in("user_id", c))
    : await all<DueRow>((from, to) =>
        admin.from("retention_queue").select(cols).lte("purge_after", today).order("purge_after").order("user_id").range(from, to),
      );
  return rows.sort((a, b) => a.purge_after.localeCompare(b.purge_after) || a.user_id.localeCompare(b.user_id));
}

/** Purges that stopped halfway, oldest first. */
async function inProgress(admin: SupabaseClient, userIds?: readonly string[]): Promise<string[]> {
  type Row = { user_id: string; started_at: string };
  const rows = userIds
    ? await inChunks<Row>([...userIds], (c) => admin.from("retention_purges").select("user_id, started_at").in("user_id", c))
    : await all<Row>((from, to) => admin.from("retention_purges").select("user_id, started_at").order("started_at").range(from, to));
  return rows.sort((a, b) => a.started_at.localeCompare(b.started_at)).map((r) => r.user_id);
}

/** How many people a purge run would process now (due by the live rules, plus unfinished purges). */
export async function countDue(admin: SupabaseClient, now: Date = new Date()): Promise<{ due: number; inProgress: number }> {
  const [due, resuming] = await Promise.all([dueFromSchedule(admin, utcDay(now)), inProgress(admin)]);
  return { due: due.filter((r) => !resuming.includes(r.user_id)).length, inProgress: resuming.length };
}

async function plan(admin: SupabaseClient, rows: DueRow[]): Promise<PlannedPurge[]> {
  const previews = await inChunks<z.infer<typeof PreviewRow>>(rows.map((r) => r.user_id), async (c) => {
    const { data, error } = await admin.rpc("retention_preview", { p_user_ids: c });
    return { data: data ? z.array(PreviewRow).parse(data) : null, error };
  });
  const byUser = new Map(previews.map((p) => [p.user_id, p]));
  const out: PlannedPurge[] = [];
  for (const r of rows) {
    const p = byUser.get(r.user_id);
    const found = await inventory(admin, r.user_id, p?.submission_ids ?? []);
    out.push({
      userId: r.user_id,
      purgeAfter: r.purge_after,
      reason: r.reason,
      decisions: p?.decisions ?? 0,
      reasoningResponses: p?.reasoning_responses ?? 0,
      quizResponses: p?.quiz_responses ?? 0,
      grades: p?.grades ?? 0,
      storage: Object.fromEntries([...found].map(([b, paths]) => [b, paths.length])),
    });
  }
  return out;
}

async function deleteAuthUser(admin: SupabaseClient, userId: string): Promise<void> {
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (!error) return;
  const status = (error as { status?: number }).status;
  if (status === 404 || /not.?found/i.test(error.message)) return; // already gone (a resumed purge)
  throw new RetentionError(`could not delete the auth user: ${error.message}`);
}

async function note(admin: SupabaseClient, userId: string, step: "storage" | "auth" | "error", counts: Record<string, unknown> = {}, err?: string) {
  const { error } = await admin.rpc("retention_note_progress", { p_user_id: userId, p_step: step, p_counts: counts, p_error: err ?? null });
  if (error) throw new RetentionError(`retention_note_progress: ${error.message}`);
}

/** Purges one person (or finishes a purge that stopped halfway). */
async function purgeOne(admin: SupabaseClient, userId: string, today: string, pepper: string, triggeredBy: string): Promise<PurgeOutcome> {
  const userIdHash = hashUserId(userId, pepper);
  let begun = false;
  try {
    const { data, error } = await admin.rpc("retention_begin_purge", { p_user_id: userId, p_hash: userIdHash, p_today: today });
    if (error) throw new RetentionError(`retention_begin_purge: ${error.message}`);
    const state = PurgeState.parse(data);
    if (state.status === "not_due" || state.status === "not_eligible") {
      return { userIdHash, status: "skipped", reason: state.status };
    }
    begun = true;
    if (!state.storage_done_at) {
      const removed = await clearStorage(admin, userId, state.submission_ids ?? []);
      const prior = (state.counts?.storage_objects_deleted ?? {}) as Record<string, number>;
      const merged = { ...prior };
      for (const [b, n] of Object.entries(removed)) merged[b] = (merged[b] ?? 0) + n;
      await note(admin, userId, "storage", { storage_objects_deleted: merged });
    }
    if (!state.auth_deleted_at) {
      await deleteAuthUser(admin, userId);
      await note(admin, userId, "auth");
    }
    const { data: logId, error: finErr } = await admin.rpc("retention_finish_purge", {
      p_user_id: userId,
      p_detail: { triggered_by: triggeredBy },
    });
    if (finErr) throw new RetentionError(`retention_finish_purge: ${finErr.message}`);
    let counts: Record<string, unknown> = {};
    if (logId) {
      const { data: log } = await admin.from("purge_log").select("detail").eq("id", logId).maybeSingle();
      counts = (log?.detail as Record<string, unknown> | undefined) ?? {};
    }
    return { userIdHash, status: "purged", resumed: state.status === "resumed", purgeLogId: (logId as string | null) ?? null, counts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (begun) await note(admin, userId, "error", {}, message).catch(() => undefined);
    console.error("retention purge failed", userIdHash.slice(0, 12), message);
    return { userIdHash, status: "failed", error: message };
  }
}

/**
 * Purges everyone whose purge date has passed (bounded by `limit`), finishing interrupted
 * purges first. With dryRun, reports who would be purged and what would go, and writes nothing.
 */
export async function purgeDue(admin: SupabaseClient, opts: PurgeOptions = {}): Promise<PurgeReport> {
  const now = opts.now ?? new Date();
  const today = utcDay(now);
  const limit = Math.max(0, Math.floor(opts.limit ?? RETENTION_SWEEP_LIMIT));

  if (opts.dryRun) {
    const [due, resuming] = await Promise.all([dueFromSchedule(admin, today, opts.userIds), inProgress(admin, opts.userIds)]);
    const planned = await plan(admin, due.slice(0, limit));
    return {
      dryRun: true,
      today,
      due: due.length,
      inProgress: resuming.length,
      planned,
      outcomes: [],
      purged: 0,
      failed: 0,
      remaining: Math.max(0, due.length - planned.length),
    };
  }

  const pepper = retentionPepper();
  await refreshRetentionQueue(admin);
  const resuming = await inProgress(admin, opts.userIds);
  const due = (await dueFromQueue(admin, today, opts.userIds)).filter((r) => !resuming.includes(r.user_id));
  const order = [...resuming, ...due.map((r) => r.user_id)];
  const batch = order.slice(0, limit);

  const outcomes: PurgeOutcome[] = [];
  for (const userId of batch) {
    outcomes.push(await purgeOne(admin, userId, today, pepper, opts.triggeredBy ?? "manual"));
  }
  return {
    dryRun: false,
    today,
    due: order.length,
    inProgress: resuming.length,
    planned: [],
    outcomes,
    purged: outcomes.filter((o) => o.status === "purged").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    remaining: Math.max(0, order.length - batch.length),
  };
}
