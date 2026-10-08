import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminHarnessRequest, dispatchRepoHarness, errorOutcome, harnessResponse, SubmissionIdParam } from "@/lib/server/harness";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Admin: start the repo checks R1–R7. With GITHUB_ACTIONS_TOKEN and GITHUB_ACTIONS_REPO set
 * this dispatches .github/workflows/verify-swe1.yml (candidate code runs there, in a job with
 * no secrets); otherwise it returns the commands to run locally.
 */
export async function POST(request: Request, { params }: { params: Promise<{ submissionId: string }> }) {
  const req = await adminHarnessRequest(request);
  if (req instanceof NextResponse) return req;
  const { submissionId } = await params;
  if (!SubmissionIdParam.safeParse(submissionId).success) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const d = await dispatchRepoHarness(createAdminClient(), submissionId, req.user.id);
    const message = d.dispatched ? `${d.message}${d.runUrl ? ` ${d.runUrl}` : ""}` : `${d.message} ${d.commands.join("  &&  ")}`;
    return harnessResponse(request, req, submissionId, { ok: true, message, data: d });
  } catch (err) {
    return harnessResponse(request, req, submissionId, errorOutcome(err));
  }
}
