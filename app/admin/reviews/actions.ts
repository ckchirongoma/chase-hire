"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";

/** Reply to a candidate's review request (POPIA s71 representations). The candidate sees the reply. */
const Reply = z.object({
  review_id: z.uuid(),
  response: z.string().trim().min(5, "Write a reply the candidate can read.").max(4000),
  close: z.enum(["0", "1"]).default("0"),
});

export async function respondToReview(formData: FormData) {
  const { supabase, user } = await requireAdmin();
  const parsed = Reply.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`/admin/reviews?error=${encodeURIComponent(parsed.error.issues[0].message)}`);
  const { review_id, response, close } = parsed.data;
  const { data, error } = await supabase
    .from("review_requests")
    .update({ response, status: close === "1" ? "closed" : "responded", responded_by: user.id, responded_at: new Date().toISOString() })
    .eq("id", review_id)
    .select("id");
  if (error) redirect(`/admin/reviews?error=${encodeURIComponent(error.message)}`);
  if (!data?.length) redirect(`/admin/reviews?error=${encodeURIComponent("Review request not found.")}`);
  redirect("/admin/reviews?ok=1");
}
