import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { DraftBody } from "@/lib/work/schema";
import { saveDraft, workErrorResponse } from "@/lib/server/work";
import { routeUser } from "@/lib/server/route";

/** Autosave. The DB refuses drafts before Start, after submit and after the deadline (+5 s). */
export async function POST(request: Request, { params }: { params: Promise<{ attemptId: string }> }) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const { attemptId } = await params;
  if (!z.uuid().safeParse(attemptId).success) return NextResponse.json({ error: "Assessment not found" }, { status: 404 });
  const parsed = DraftBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid draft" }, { status: 400 });
  try {
    return NextResponse.json(await saveDraft(createAdminClient(), auth.user.id, attemptId, parsed.data.draft));
  } catch (err) {
    return workErrorResponse(err);
  }
}
