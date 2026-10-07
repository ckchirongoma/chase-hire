import "server-only";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/** Returns the signed-in user for an API route, or a 401 response. */
export async function routeUser(): Promise<{ user: User; supabase: Awaited<ReturnType<typeof createClient>> } | NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return { user, supabase };
}

export function errorResponse(err: unknown) {
  const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
  const message = err instanceof Error && status < 500 ? err.message : "Something went wrong";
  if (status >= 500) console.error(err);
  return NextResponse.json({ error: message }, { status });
}
