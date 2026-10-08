import { after, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { InterviewConflict, postInterviewMessage } from "@/lib/server/interview";
import { errorResponse, routeUser } from "@/lib/server/route";

// The last answer ends the interview and kicks off grading after the response.
export const maxDuration = 300;

/** `turn` is the token from the state the candidate was looking at when they answered. */
const Body = z.object({ content: z.string().trim().min(1).max(4000), turn: z.number().int().min(0) });

/** Sends the candidate's answer; returns the interview state with the next question(s). */
export async function POST(request: Request, { params }: { params: Promise<{ applicationId: string }> }) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const { applicationId } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(applicationId).success || !parsed.success) {
    return NextResponse.json({ error: "Answers must be between 1 and 4,000 characters" }, { status: 400 });
  }
  try {
    const state = await postInterviewMessage(createAdminClient(), auth.user.id, applicationId, parsed.data, (task) =>
      after(() => task().catch((e) => console.error("interview grading failed", e))),
    );
    return NextResponse.json(state);
  } catch (err) {
    // A stale or repeated answer: send the current state so the client can refresh and keep the draft.
    if (err instanceof InterviewConflict) return NextResponse.json({ error: err.message, state: err.state }, { status: 409 });
    return errorResponse(err);
  }
}
