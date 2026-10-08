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

/** The stage page is going away (hidden, closed, reloaded or navigated off): start the away clock. */
export async function markAway(admin: SupabaseClient, userId: string, kind: TabKind, id: string, reason: "hidden" | "closed"): Promise<void> {
  const { error } = await admin.rpc("mark_away", { p_kind: kind, p_id: id, p_user: userId, p_reason: reason });
  if (error) throw new Error(error.message);
}

/**
 * The stage page is showing again (after a hide, or loaded again after a close or reload). The
 * time away is measured by the DB clock and goes through the tab rule.
 */
export async function markBack(admin: SupabaseClient, userId: string, kind: TabKind, id: string, clientHiddenMs: number | null): Promise<TabStatus> {
  const { data, error } = await admin.rpc("mark_back", {
    p_kind: kind,
    p_id: id,
    p_user: userId,
    p_client_ms: clientHiddenMs === null ? null : Math.round(clientHiddenMs),
  });
  if (error) {
    if (error.message.includes("not_found")) throw Object.assign(new Error("Not found"), { status: 404 });
    throw new Error(error.message);
  }
  return data as TabStatus;
}
