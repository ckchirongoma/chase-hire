import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Tab rule for the timed stages (reasoning, role quiz, AI interview): leaving the page for 2+
 * seconds the first time pauses the stage (the candidate confirms to continue); the second time
 * locks it until an admin reopens it with the time that was left. Never an automatic rejection.
 */
export type TabKind = "reasoning" | "quiz" | "interview";
export type TabStatus = "paused" | "locked" | "ignored";

export async function recordTabLeave(admin: SupabaseClient, userId: string, kind: TabKind, id: string, hiddenMs: number): Promise<TabStatus> {
  const { data, error } = await admin.rpc("record_tab_leave", { p_kind: kind, p_id: id, p_user: userId, p_hidden_ms: Math.round(hiddenMs) });
  if (error) {
    if (error.message.includes("not_found")) throw Object.assign(new Error("Not found"), { status: 404 });
    throw new Error(error.message);
  }
  return data as TabStatus;
}
