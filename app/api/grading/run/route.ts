import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/server/auth";
import { enqueueGrading, runGradingJob, runPendingGradingJobs } from "@/lib/server/grading";
import { endExpiredInterviews } from "@/lib/server/interview";
import { errorResponse, routeUser } from "@/lib/server/route";
import { SUBJECT_TYPES } from "@/lib/grading/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({ subjectType: z.enum(SUBJECT_TYPES), subjectId: z.uuid() });

/** Admin: (re-)run grading for one subject now. AI grades stay advisory; nothing changes status. */
export async function POST(request: Request) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  if (!(await isAdmin(auth.supabase))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    const admin = createAdminClient();
    const jobId = await enqueueGrading(admin, parsed.data.subjectType, parsed.data.subjectId);
    return NextResponse.json(await runGradingJob(admin, jobId));
  } catch (err) {
    return errorResponse(err);
  }
}

// Cron worker: end expired interviews, then process pending grading jobs.
//
// DEPLOYMENT DEPENDENCY: this must be scheduled, or abandoned interviews (tab closed) never end,
// failed grading jobs are never retried, and a job killed mid-run (the after() run from the
// interview routes is capped at maxDuration) stays "running". Add to vercel.json "crons":
//   { "path": "/api/grading/run", "schedule": "*/5 * * * *" }   (every 5 minutes)
// Vercel sends "Authorization: Bearer $CRON_SECRET". Sub-daily schedules need a paid Vercel plan;
// otherwise call this URL with the same header from pg_cron + pg_net (or any scheduler).
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const limit = Math.min(10, Math.max(1, Number(new URL(request.url).searchParams.get("limit")) || 3));
  try {
    const admin = createAdminClient();
    const interviewsEnded = await endExpiredInterviews(admin);
    const jobs = await runPendingGradingJobs(admin, { limit });
    return NextResponse.json({ interviewsEnded, jobs });
  } catch (err) {
    return errorResponse(err);
  }
}
