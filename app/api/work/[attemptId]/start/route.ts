import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { startWork, workErrorResponse } from "@/lib/server/work";
import { routeUser } from "@/lib/server/route";

/** Start the work window. The DB sets started_at and deadline_at; a second Start is a no-op. */
export async function POST(_request: Request, { params }: { params: Promise<{ attemptId: string }> }) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const { attemptId } = await params;
  if (!z.uuid().safeParse(attemptId).success) return NextResponse.json({ error: "Assessment not found" }, { status: 404 });
  try {
    return NextResponse.json(await startWork(createAdminClient(), auth.user.id, attemptId));
  } catch (err) {
    return workErrorResponse(err);
  }
}
