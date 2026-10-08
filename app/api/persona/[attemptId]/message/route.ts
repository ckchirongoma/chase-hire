import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { PERSONA_MAX_MESSAGE_CHARS } from "@/lib/persona/facts";
import { PersonaConflict, postPersonaMessage } from "@/lib/server/persona";
import { errorResponse, routeUser } from "@/lib/server/route";

export const maxDuration = 60;

const Body = z.object({ content: z.string().trim().min(1).max(PERSONA_MAX_MESSAGE_CHARS) });

/** Sends one message to Lerato and returns the chat with her reply. */
export async function POST(request: Request, { params }: { params: Promise<{ attemptId: string }> }) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const { attemptId } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(attemptId).success) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  if (!parsed.success) {
    return NextResponse.json({ error: `Messages must be between 1 and ${PERSONA_MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters` }, { status: 400 });
  }
  try {
    return NextResponse.json(await postPersonaMessage(createAdminClient(), auth.user.id, attemptId, parsed.data.content));
  } catch (err) {
    if (err instanceof PersonaConflict) return NextResponse.json({ error: err.message, state: err.state }, { status: 409 });
    // PersonaError carries its status: errorResponse returns its message below 500, and logs and
    // hides it (database or model details) from 500 up.
    return errorResponse(err);
  }
}
