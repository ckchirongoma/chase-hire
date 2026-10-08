import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { finaliseExpiredQuizzes } from "@/lib/server/quiz";
import { errorResponse } from "@/lib/server/route";

export const dynamic = "force-dynamic";

/**
 * Vercel Cron safety net: finalise role-quiz attempts abandoned past their deadline, so the
 * application reaches awaiting_review and admins see the score. Same CRON_SECRET bearer
 * check as /api/cron/finalise-reasoning. Never advances or rejects anyone.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  try {
    const finalised = await finaliseExpiredQuizzes(createAdminClient());
    return NextResponse.json({ finalised });
  } catch (err) {
    return errorResponse(err);
  }
}
