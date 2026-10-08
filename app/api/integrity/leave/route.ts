import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordTabLeave } from "@/lib/server/integrity";
import { errorResponse, routeUser } from "@/lib/server/route";

const Body = z.object({
  kind: z.enum(["reasoning", "quiz", "interview"]),
  id: z.uuid(),
  hiddenMs: z.number().int().min(0).max(24 * 3_600_000),
});

/** The candidate's page reports it was hidden; returns paused | locked | ignored. */
export async function POST(request: Request) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    const status = await recordTabLeave(createAdminClient(), auth.user.id, parsed.data.kind, parsed.data.id, parsed.data.hiddenMs);
    return NextResponse.json({ status });
  } catch (err) {
    return errorResponse(err);
  }
}
