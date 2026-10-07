import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { RoleSlug } from "@/lib/quiz/api-schema";
import { startQuiz } from "@/lib/server/quiz";
import { errorResponse, routeUser } from "@/lib/server/route";

/** Start (or resume) the role quiz for the signed-in user's application. */
export async function POST(_request: Request, { params }: { params: Promise<{ role: string }> }) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const role = RoleSlug.safeParse((await params).role);
  if (!role.success) return NextResponse.json({ error: "Unknown role" }, { status: 404 });
  try {
    return NextResponse.json(await startQuiz(createAdminClient(), auth.user.id, role.data));
  } catch (err) {
    return errorResponse(err);
  }
}
