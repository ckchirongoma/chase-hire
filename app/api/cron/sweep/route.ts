import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { finaliseExpired } from "@/lib/server/reasoning";
import { endExpiredInterviews } from "@/lib/server/interview";
import { finaliseExpiredQuizzes } from "@/lib/server/quiz";
import { runPendingGradingJobs } from "@/lib/server/grading";
import { refreshScores } from "@/lib/server/scores";
import { errorResponse } from "@/lib/server/route";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Background safety net (Vercel Cron, or pg_cron + pg_net; see README). Every timed stage is
 * also finalised lazily when the candidate next loads it, and grading starts right after a
 * stage ends; this sweep catches abandoned sessions, retries failed grading jobs and refreshes
 * the composite scores.
 * It never advances or rejects anyone.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  try {
    const admin = createAdminClient();
    const reasoning = await finaliseExpired(admin);
    const interviews = await endExpiredInterviews(admin);
    const quizzes = await finaliseExpiredQuizzes(admin);
    const jobs = await runPendingGradingJobs(admin, { limit: 5 });
    // Composite scores (they only sort the admin's queue) catch up with human overrides etc.
    const scores = await refreshScores(admin);
    return NextResponse.json({ reasoning, interviews, quizzes, gradingJobs: jobs.length, scoresUpdated: scores });
  } catch (err) {
    return errorResponse(err);
  }
}
