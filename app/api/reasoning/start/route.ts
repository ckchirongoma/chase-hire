import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { startAttempt } from "@/lib/server/reasoning";
import { errorResponse, routeUser } from "@/lib/server/route";

export async function POST() {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json(await startAttempt(createAdminClient(), auth.user.id));
  } catch (err) {
    return errorResponse(err);
  }
}
