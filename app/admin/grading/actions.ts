"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";
import { refreshQuietly, refreshScoresForSubject } from "@/lib/server/scores";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * A person resolves an AI-graded criterion flagged for review (spread of 2+, no evidence, no
 * answers, a calibration hold). The human score replaces the AI median in final_score; DB
 * triggers rescore the interview or submission. The reason is stored and shown next to it.
 */
const Override = z.object({
  subject_type: z.enum(["interview", "submission"]),
  subject_id: z.uuid(),
  criterion_key: z.string().min(1).max(80),
  score: z.coerce.number().int().min(1, "Score 1 to 5.").max(5, "Score 1 to 5."),
  reason: z.string().trim().min(20, "The reason must be at least 20 characters and reference the evidence."),
  back: z.string().regex(/^\/admin\/(grading|candidates\/[0-9a-f-]{36})(\?[\w=&%.-]*)?$/).optional(),
});

export async function overrideGrade(formData: FormData) {
  const { supabase, user } = await requireAdmin();
  const parsed = Override.safeParse(Object.fromEntries(formData));
  const back = parsed.success && parsed.data.back ? parsed.data.back : "/admin/grading";
  const go = (params: Record<string, string>): never => {
    const url = new URL(back, "http://x");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    redirect(`${url.pathname}${url.search}`);
  };
  if (!parsed.success) go({ error: parsed.error.issues[0].message });
  const d = parsed.data!;
  const { data, error } = await supabase
    .from("grade_summaries")
    .update({ human_score: d.score, human_reason: d.reason, human_by: user.id, human_at: new Date().toISOString() })
    .eq("subject_type", d.subject_type)
    .eq("subject_id", d.subject_id)
    .eq("criterion_key", d.criterion_key)
    .select("criterion_key");
  if (error) go({ error: error.message });
  if (!data?.length) go({ error: "That criterion was not found." });
  await refreshQuietly(refreshScoresForSubject(createAdminClient(), d.subject_type, d.subject_id));
  go({ ok: `Saved your score for ${d.criterion_key}.` });
}
