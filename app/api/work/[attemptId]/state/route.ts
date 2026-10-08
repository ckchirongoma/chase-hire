import { after, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWorkStateByAttempt, workErrorResponse } from "@/lib/server/work";
import { routeUser } from "@/lib/server/route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The candidate's view of one work attempt (status, clocks, draft, submission summary). */
export async function GET(_request: Request, { params }: { params: Promise<{ attemptId: string }> }) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const { attemptId } = await params;
  if (!z.uuid().safeParse(attemptId).success) return NextResponse.json({ error: "Assessment not found" }, { status: 404 });
  try {
    const view = await getWorkStateByAttempt(createAdminClient(), auth.user.id, attemptId, (task) =>
      after(() => task().catch((e) => console.error("work: deferred task failed", e))),
    );
    return NextResponse.json(view);
  } catch (err) {
    return workErrorResponse(err);
  }
}
