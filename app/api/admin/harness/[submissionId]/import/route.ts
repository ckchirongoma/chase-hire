import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminHarnessRequest, describeRun, errorOutcome, harnessResponse, Overrides, runImportHarness, SubmissionIdParam } from "@/lib/server/harness";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** The admin must confirm: this uploads the month-2 files into the candidate's live app. */
const Body = Overrides.and(
  z.object({
    confirm: z.union([z.literal(true), z.literal("yes"), z.literal("on"), z.literal("true")], {
      error: "Tick the box to confirm: this changes data in the candidate's deployed database.",
    }),
  }),
);

/**
 * Admin: run the month-2 import checks M1–M7 and data checks D-a..D-c as the candidate's
 * manager login. Mutates the candidate's deployed database (month-2 file twice, drift file
 * once), so it needs an explicit confirm. Writes verification_runs rows.
 */
export async function POST(request: Request, { params }: { params: Promise<{ submissionId: string }> }) {
  const req = await adminHarnessRequest(request);
  if (req instanceof NextResponse) return req;
  const { submissionId } = await params;
  if (!SubmissionIdParam.safeParse(submissionId).success) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return harnessResponse(request, req, submissionId, { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid request", status: 400 });
  try {
    const summary = await runImportHarness(createAdminClient(), submissionId, {
      ranBy: req.user.id,
      overrides: { supabaseUrl: parsed.data.supabase_url ?? null, anonKey: parsed.data.anon_key ?? null },
    });
    return harnessResponse(request, req, submissionId, { ok: true, message: describeRun("Import and data checks", summary), data: summary });
  } catch (err) {
    return harnessResponse(request, req, submissionId, errorOutcome(err));
  }
}
