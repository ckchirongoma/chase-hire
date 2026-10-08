import { redirect } from "next/navigation";
import { getCandidateState, isAdmin, nextStep, requireUser } from "@/lib/server/auth";

/** Sends a signed-in user to their next step: the admin area for staff, the next stage for candidates. */
export default async function StartPage() {
  const { supabase, user } = await requireUser();
  if (await isAdmin(supabase)) redirect("/admin/pipeline");
  redirect(nextStep(await getCandidateState(supabase, user.id)));
}
