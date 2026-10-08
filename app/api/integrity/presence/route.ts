import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { markAway, markBack } from "@/lib/server/integrity";
import { errorResponse, routeUser } from "@/lib/server/route";

const Body = z.discriminatedUnion("event", [
  z.object({ event: z.literal("away"), kind: z.enum(["reasoning", "quiz", "interview"]), id: z.uuid(), reason: z.enum(["hidden", "closed"]) }),
  z.object({
    event: z.literal("back"),
    kind: z.enum(["reasoning", "quiz", "interview"]),
    id: z.uuid(),
    hiddenMs: z.number().int().min(0).max(24 * 3_600_000).nullable(),
  }),
]);

/**
 * Presence for the tab rule. "away" is sent as a beacon when the page is hidden, closed, reloaded
 * or left; "back" when the stage page shows again and returns paused | locked | ignored.
 */
export async function POST(request: Request) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const b = parsed.data;
  try {
    if (b.event === "away") {
      await markAway(createAdminClient(), auth.user.id, b.kind, b.id, b.reason);
      return NextResponse.json({ status: "away" });
    }
    const status = await markBack(createAdminClient(), auth.user.id, b.kind, b.id, b.hiddenMs);
    return NextResponse.json({ status });
  } catch (err) {
    return errorResponse(err);
  }
}
