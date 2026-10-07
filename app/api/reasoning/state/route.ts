import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getState } from "@/lib/server/reasoning";
import { errorResponse, routeUser } from "@/lib/server/route";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json(await getState(createAdminClient(), auth.user.id));
  } catch (err) {
    return errorResponse(err);
  }
}
