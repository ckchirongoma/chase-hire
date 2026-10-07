import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { answer } from "@/lib/server/reasoning";
import { errorResponse, routeUser } from "@/lib/server/route";

const Body = z.object({
  attemptId: z.uuid(),
  position: z.number().int().min(1).max(30),
  answer: z.number().int().min(0).max(4).nullable(), // null = skip
});

/** Submit the answer for the current item and receive the next one. */
export async function POST(request: Request) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    const { attemptId, position, answer: choice } = parsed.data;
    return NextResponse.json(await answer(createAdminClient(), auth.user.id, attemptId, position, choice));
  } catch (err) {
    return errorResponse(err);
  }
}
