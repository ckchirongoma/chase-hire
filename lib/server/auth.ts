import "server-only";
import { notFound, redirect } from "next/navigation";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

export async function getUser(): Promise<{ supabase: SupabaseClient; user: User | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

export async function requireUser(next = "/start") {
  const { supabase, user } = await getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);
  return { supabase, user };
}

export async function isAdmin(supabase: SupabaseClient): Promise<boolean> {
  const { data } = await supabase.rpc("is_admin");
  return data === true;
}

/** Admin pages 404 for everyone else, so they don't advertise themselves. */
export async function requireAdmin() {
  const { supabase, user } = await requireUser("/admin");
  if (!(await isAdmin(supabase))) notFound();
  return { supabase, user };
}

export type CandidateState = {
  consented: boolean;
  cvStatus: "processing" | "parsed" | "failed" | null;
  reasoning: {
    id: string;
    submitted_at: string | null;
    deadline_at: string;
    started_at: string;
    raw_score: number | null;
    percentile: number | null;
    stars: number | null;
    norm_version: string | null;
  } | null;
};

export async function getCandidateState(supabase: SupabaseClient, userId: string): Promise<CandidateState> {
  const [consent, cv, attempt] = await Promise.all([
    supabase.from("consents").select("id").eq("user_id", userId).limit(1),
    supabase.from("cvs").select("status").eq("user_id", userId).order("created_at", { ascending: false }).limit(1),
    supabase
      .from("reasoning_attempts")
      .select("id, submitted_at, deadline_at, started_at, raw_score, percentile, stars, norm_version")
      .eq("user_id", userId)
      .eq("form", "online")
      .order("started_at", { ascending: false })
      .limit(1),
  ]);
  return {
    consented: (consent.data?.length ?? 0) > 0,
    cvStatus: (cv.data?.[0]?.status as CandidateState["cvStatus"]) ?? null,
    reasoning: (attempt.data?.[0] as CandidateState["reasoning"]) ?? null,
  };
}

/** Where a candidate should go next. */
export function nextStep(state: CandidateState): string {
  if (!state.consented) return "/consent";
  if (state.cvStatus !== "parsed") return "/profile";
  if (!state.reasoning?.submitted_at) return "/assess/reasoning";
  return "/me/results";
}
