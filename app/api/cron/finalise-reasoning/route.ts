import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { finaliseExpired } from "@/lib/server/reasoning";

/** Vercel Cron safety net: score attempts abandoned before their deadline. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const finalised = await finaliseExpired(createAdminClient());
  return NextResponse.json({ finalised });
}
