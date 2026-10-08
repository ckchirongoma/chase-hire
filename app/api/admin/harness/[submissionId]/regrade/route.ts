import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminHarnessRequest, errorOutcome, harnessResponse, regradeWithHarness, SubmissionIdParam } from "@/lib/server/harness";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Admin: re-grade the submission so the SWE1 grader reads the latest harness results. Advisory only. */
export async function POST(request: Request, { params }: { params: Promise<{ submissionId: string }> }) {
  const req = await adminHarnessRequest(request);
  if (req instanceof NextResponse) return req;
  const { submissionId } = await params;
  if (!SubmissionIdParam.safeParse(submissionId).success) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const run = await regradeWithHarness(createAdminClient(), submissionId);
    const message = run.status === "done" ? "Re-graded with the latest harness results." : run.skipped ? "Grading is already running for this submission." : `Grading ${run.status}${run.error ? `: ${run.error}` : ""}.`;
    return harnessResponse(request, req, submissionId, { ok: run.status !== "failed", message, data: run });
  } catch (err) {
    return harnessResponse(request, req, submissionId, errorOutcome(err));
  }
}
