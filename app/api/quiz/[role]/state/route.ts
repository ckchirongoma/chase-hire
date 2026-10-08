import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { RoleSlug } from "@/lib/quiz/api-schema";
import { getQuizState } from "@/lib/server/quiz";
import { errorResponse, routeUser } from "@/lib/server/route";

export const dynamic = "force-dynamic";

/** Current quiz state: the item being answered, or the result. Never includes answer keys. */
export async function GET(_request: Request, { params }: { params: Promise<{ role: string }> }) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const role = RoleSlug.safeParse((await params).role);
  if (!role.success) return NextResponse.json({ error: "Unknown role" }, { status: 404 });
  try {
    return NextResponse.json(await getQuizState(createAdminClient(), auth.user.id, role.data));
  } catch (err) {
    return errorResponse(err);
  }
}
