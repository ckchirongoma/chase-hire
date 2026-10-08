import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPersonaState } from "@/lib/server/persona";
import { errorResponse, routeUser } from "@/lib/server/route";

export const dynamic = "force-dynamic";

/** The chat so far, messages left and the chat deadline. Never includes fact ids. */
export async function GET(_request: Request, { params }: { params: Promise<{ attemptId: string }> }) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const { attemptId } = await params;
  if (!z.uuid().safeParse(attemptId).success) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  try {
    return NextResponse.json(await getPersonaState(createAdminClient(), auth.user.id, attemptId));
  } catch (err) {
    // PersonaError carries its status: errorResponse returns its message below 500, and logs and
    // hides it (database or model details) from 500 up.
    return errorResponse(err);
  }
}
