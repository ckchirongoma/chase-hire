import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminHarnessRequest, describeRun, errorOutcome, harnessResponse, Overrides, runUrlHarness, SubmissionIdParam } from "@/lib/server/harness";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Admin: run the deployed-URL checks U1–U8 for one SWE Test 1 submission. Optional
 * supabase_url / anon_key override what the bundle scan finds (for apps that hide them).
 * Writes verification_runs rows; changes no application status.
 */
export async function POST(request: Request, { params }: { params: Promise<{ submissionId: string }> }) {
  const req = await adminHarnessRequest(request);
  if (req instanceof NextResponse) return req;
  const { submissionId } = await params;
  if (!SubmissionIdParam.safeParse(submissionId).success) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = Overrides.safeParse(req.body);
  if (!parsed.success) return harnessResponse(request, req, submissionId, { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid request", status: 400 });
  try {
    const summary = await runUrlHarness(createAdminClient(), submissionId, {
      ranBy: req.user.id,
      overrides: { supabaseUrl: parsed.data.supabase_url ?? null, anonKey: parsed.data.anon_key ?? null },
    });
    return harnessResponse(request, req, submissionId, { ok: true, message: describeRun("URL checks", summary), data: summary });
  } catch (err) {
    return harnessResponse(request, req, submissionId, errorOutcome(err));
  }
}
