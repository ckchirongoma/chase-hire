import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { startPersona } from "@/lib/server/persona";
import { errorResponse, routeUser } from "@/lib/server/route";

/** Opens the 25-minute chat with Lerato (BA Part 1). The DB sets the chat deadline. */
export async function POST(_request: Request, { params }: { params: Promise<{ attemptId: string }> }) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const { attemptId } = await params;
  if (!z.uuid().safeParse(attemptId).success) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  try {
    return NextResponse.json(await startPersona(createAdminClient(), auth.user.id, attemptId));
  } catch (err) {
    // PersonaError carries its status: errorResponse returns its message below 500, and logs and
    // hides it (database or model details) from 500 up.
    return errorResponse(err);
  }
}
