import { NextResponse } from "next/server";
import { adminHarnessRequest, errorOutcome, harnessResponse, ManualResult, recordManualResult, SubmissionIdParam } from "@/lib/server/harness";

export const dynamic = "force-dynamic";

/**
 * Admin: record a reviewer's own result for one check (pass / fail / informational + note),
 * e.g. when an automated check was inconclusive. Inserted with the admin's own session, so RLS
 * applies (manual rows only, ran_by = the admin).
 */
export async function POST(request: Request, { params }: { params: Promise<{ submissionId: string }> }) {
  const req = await adminHarnessRequest(request);
  if (req instanceof NextResponse) return req;
  const { submissionId } = await params;
  if (!SubmissionIdParam.safeParse(submissionId).success) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = ManualResult.safeParse(req.body);
  if (!parsed.success) return harnessResponse(request, req, submissionId, { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid request", status: 400 });
  try {
    await recordManualResult(req.supabase, req.user, submissionId, parsed.data);
    return harnessResponse(request, req, submissionId, { ok: true, message: `Recorded ${parsed.data.check_key} as ${parsed.data.result} (manual). Re-grade to use it.`, data: { ok: true } });
  } catch (err) {
    return harnessResponse(request, req, submissionId, errorOutcome(err));
  }
}
