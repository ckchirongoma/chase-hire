import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/server/auth";
import { generateBrief } from "@/lib/server/brief";
import { errorResponse, routeUser } from "@/lib/server/route";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Admin: write (or refresh) the AI brief for a candidate. Advisory; changes nothing else. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  if (!(await isAdmin(auth.supabase))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const force = new URL(request.url).searchParams.get("force") === "1";
  try {
    return NextResponse.json(await generateBrief(createAdminClient(), id, auth.user.id, { force }));
  } catch (err) {
    return errorResponse(err);
  }
}
