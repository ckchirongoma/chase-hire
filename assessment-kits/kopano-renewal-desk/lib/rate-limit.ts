import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  resetAt: string;
}

/** Counts one call against the caller's bucket (in the database, so it holds across instances). */
export async function takeRateLimit(db: SupabaseClient, bucket: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const { data, error } = await db.rpc("take_rate_limit", { p_bucket: bucket, p_limit: limit, p_window_seconds: windowSeconds });
  if (error) throw new Error(`rate limit check failed: ${error.message}`);
  const r = data as { allowed: boolean; count: number; limit: number; reset_at: string };
  return { allowed: r.allowed, count: r.count, limit: r.limit, resetAt: r.reset_at };
}

export function retryAfterSeconds(resetAt: string): string {
  return String(Math.max(1, Math.ceil((new Date(resetAt).getTime() - Date.now()) / 1000)));
}
