import { after, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { submitWork, workErrorResponse } from "@/lib/server/work";
import { routeUser } from "@/lib/server/route";

// Snapshots and (when a handler is registered) grading run after the response.
export const maxDuration = 300;

/**
 * Submit the stage. The body is validated per stage on the server (the stage comes from the
 * attempt, never from the client). Word/page limit rejections are 422 with the counts.
 */
export async function POST(request: Request, { params }: { params: Promise<{ attemptId: string }> }) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const { attemptId } = await params;
  if (!z.uuid().safeParse(attemptId).success) return NextResponse.json({ error: "Assessment not found" }, { status: 404 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid submission" }, { status: 400 });
  try {
    const view = await submitWork(createAdminClient(), auth.user.id, attemptId, body, (task) => after(task));
    return NextResponse.json(view);
  } catch (err) {
    return workErrorResponse(err);
  }
}
