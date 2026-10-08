import "server-only";
import { createClient } from "@supabase/supabase-js";
import { publicEnv } from "@/lib/config";

/**
 * Service-role client. Bypasses RLS, so use it only in route handlers / server actions
 * after checking who the caller is. Never import this from a client component.
 */
export function createAdminClient() {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error("SUPABASE_SECRET_KEY is not set");
  return createClient(publicEnv().NEXT_PUBLIC_SUPABASE_URL, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
