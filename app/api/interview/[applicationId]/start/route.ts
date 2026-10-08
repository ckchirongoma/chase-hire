import { after, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { startInterview } from "@/lib/server/interview";
import { errorResponse, routeUser } from "@/lib/server/route";

// Resuming a session that has timed out ends it and kicks off grading after the response.
export const maxDuration = 300;

/** Starts the AI CV-verification interview (or returns the existing session). */
export async function POST(_request: Request, { params }: { params: Promise<{ applicationId: string }> }) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const { applicationId } = await params;
  if (!z.uuid().safeParse(applicationId).success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    const state = await startInterview(createAdminClient(), auth.user.id, applicationId, (task) =>
      after(() => task().catch((e) => console.error("interview grading failed", e))),
    );
    return NextResponse.json(state);
  } catch (err) {
    return errorResponse(err);
  }
}
