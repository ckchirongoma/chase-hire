import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { finaliseExpired } from "@/lib/server/reasoning";
import { endExpiredInterviews } from "@/lib/server/interview";
import { finaliseExpiredQuizzes } from "@/lib/server/quiz";
import { runPendingGradingJobs } from "@/lib/server/grading";
import { refreshScores } from "@/lib/server/scores";
import { errorResponse } from "@/lib/server/route";
import { purgeDue } from "@/lib/server/retention";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
/** No new purge starts after this much of the run (each purge is resumable, but the response with `errors` must get out). */
const PURGE_BUDGET_MS = 240_000;

/**
 * Background safety net (Vercel Cron, or pg_cron + pg_net; see README). Every timed stage is
 * also finalised lazily when the candidate next loads it, and grading starts right after a
 * stage ends; this sweep catches abandoned sessions, retries failed grading jobs and refreshes
 * the composite scores. Then it recomputes the reasoning item statistics (docs/04 §4) and runs
 * the retention purge (docs/12): it refreshes the retention queue, then purges everyone due
 * until 240 s into the run (no fixed count, so a backlog clears in a run or two; the rest are
 * reported in `remaining` and done next run; interrupted purges alternate with new ones), drops
 * archived decisions older than 3 years and deletes files uploaded under a purged id after its
 * purge. Those steps report their errors in `errors` (and the log) without hiding the others'
 * results. It never advances, rejects or closes anyone's application.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const startedAt = Date.now();
  try {
    const admin = createAdminClient();
    const reasoning = await finaliseExpired(admin);
    const interviews = await endExpiredInterviews(admin);
    const quizzes = await finaliseExpiredQuizzes(admin);
    const jobs = await runPendingGradingJobs(admin, { limit: 5 });
    // Composite scores (they only sort the admin's queue) catch up with human overrides etc.
    const scores = await refreshScores(admin);

    const errors: string[] = [];
    let itemStats: number | null = null;
    try {
      const { data, error } = await admin.rpc("refresh_reasoning_item_stats");
      if (error) throw new Error(error.message);
      itemStats = Number(data ?? 0);
    } catch (err) {
      console.error("sweep: item statistics", err);
      errors.push(`item statistics: ${err instanceof Error ? err.message : String(err)}`);
    }
    let retention: {
      due: number;
      purged: number;
      failed: number;
      remaining: number;
      stoppedAtDeadline: boolean;
      archiveExpired: number;
      lateUploads: { checked: number; cleared: number; objects: number };
    } | null = null;
    try {
      const r = await purgeDue(admin, { triggeredBy: "sweep", deadline: startedAt + PURGE_BUDGET_MS });
      retention = {
        due: r.due,
        purged: r.purged,
        failed: r.failed,
        remaining: r.remaining,
        stoppedAtDeadline: r.stoppedAtDeadline,
        archiveExpired: r.archiveExpired,
        lateUploads: r.lateUploads,
      };
      if (r.failed) errors.push(`retention: ${r.failed} purge(s) failed and will be retried`);
    } catch (err) {
      console.error("sweep: retention", err);
      errors.push(`retention: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Failed purges stay in progress (shown on /admin/compliance) and are retried next run.
    return NextResponse.json({ reasoning, interviews, quizzes, gradingJobs: jobs.length, scoresUpdated: scores, itemStats, retention, errors });
  } catch (err) {
    return errorResponse(err);
  }
}
