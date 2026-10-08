import { after, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { getInterviewState } from "@/lib/server/interview";
import { errorResponse, routeUser } from "@/lib/server/route";

export const dynamic = "force-dynamic";
// Ending a timed-out session kicks off grading after the response.
export const maxDuration = 300;

export async function GET(_request: Request, { params }: { params: Promise<{ applicationId: string }> }) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const { applicationId } = await params;
  if (!z.uuid().safeParse(applicationId).success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    const state = await getInterviewState(createAdminClient(), auth.user.id, applicationId, (task) =>
      after(() => task().catch((e) => console.error("interview grading failed", e))),
    );
    return NextResponse.json(state);
  } catch (err) {
    return errorResponse(err);
  }
}
