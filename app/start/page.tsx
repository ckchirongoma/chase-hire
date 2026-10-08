import { redirect } from "next/navigation";
import { getCandidateState, nextStep, requireUser } from "@/lib/server/auth";

/** Sends a signed-in candidate to their next step. */
export default async function StartPage() {
  const { supabase, user } = await requireUser();
  redirect(nextStep(await getCandidateState(supabase, user.id)));
}
