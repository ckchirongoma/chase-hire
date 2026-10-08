import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { listDatasets, workErrorResponse } from "@/lib/server/work";
import { routeUser } from "@/lib/server/route";

export const dynamic = "force-dynamic";

/** Signed 10-minute links to the stage's candidate files, only between Start and the deadline. */
export async function GET(_request: Request, { params }: { params: Promise<{ attemptId: string }> }) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const { attemptId } = await params;
  if (!z.uuid().safeParse(attemptId).success) return NextResponse.json({ error: "Assessment not found" }, { status: 404 });
  try {
    const files = await listDatasets(createAdminClient(), auth.user.id, attemptId);
    return NextResponse.json({ files }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return workErrorResponse(err);
  }
}
