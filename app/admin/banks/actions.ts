"use server";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/server/auth";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Recomputes the reasoning item statistics now (docs/04 §4) instead of waiting for the nightly
 * sweep. The function is service-role only, so it runs after the admin check.
 */
export async function recomputeItemStats() {
  await requireAdmin();
  const { data, error } = await createAdminClient().rpc("refresh_reasoning_item_stats");
  if (error) redirect(`/admin/banks?error=${encodeURIComponent(error.message)}#reasoning`);
  const n = Number(data ?? 0);
  redirect(`/admin/banks?ok=${encodeURIComponent(`Item statistics recomputed: ${n} template${n === 1 ? "" : "s"} changed.`)}#reasoning`);
}
