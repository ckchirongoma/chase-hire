"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";
import { BLUEPRINT, QUIZ_ROLES, topicLabel } from "@/lib/quiz/blueprint";
import { NewQuizItem } from "@/lib/quiz/item-schema";
import { bankUrl } from "./url";

// Admin-only server actions for /admin/quiz-bank. requireAdmin() 404s for anyone else, and
// the writes go through the admin's own session, so RLS (admin-only insert/update) applies too.

const Toggle = z.object({
  id: z.uuid(),
  active: z.enum(["true", "false"]),
  role: z.enum(QUIZ_ROLES),
  topic: z.string().optional(),
});

/** Activates or deactivates an item, refusing to leave a topic too thin for a quiz to be built. */
export async function toggleQuizItem(formData: FormData) {
  const { supabase } = await requireAdmin();
  const parsed = Toggle.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(bankUrl("software-engineer", { error: "Invalid request" }));
  const { id, role, topic } = parsed.data;
  const makeActive = parsed.data.active === "true";

  if (!makeActive) {
    // Keep enough active items per topic for every new attempt to be assembled.
    const { data: item } = await supabase.from("quiz_items").select("topic").eq("id", id).single();
    const need = BLUEPRINT[role].find((b) => b.topic === item?.topic)?.count ?? 0;
    const { count } = await supabase
      .from("quiz_items")
      .select("id", { count: "exact", head: true })
      .eq("role_slug", role)
      .eq("topic", item?.topic ?? "")
      .eq("active", true)
      .neq("id", id);
    if ((count ?? 0) < need) {
      redirect(
        bankUrl(role, {
          topic,
          error: `Can't deactivate: ${topicLabel(item?.topic ?? "")} needs at least ${need} active items for a quiz to be built.`,
        }),
      );
    }
  }

  const { error } = await supabase.from("quiz_items").update({ active: makeActive }).eq("id", id);
  if (error) redirect(bankUrl(role, { topic, error: error.message }));
  redirect(bankUrl(role, { topic, ok: makeActive ? "Item activated." : "Item deactivated." }));
}

/** Adds a new item from the admin form (validated by NewQuizItem). */
export async function addQuizItem(formData: FormData) {
  const { supabase } = await requireAdmin();
  const raw = Object.fromEntries(formData);
  const fallbackRole = String(raw.role_topic ?? "").split(":")[0] || "software-engineer";
  const parsed = NewQuizItem.safeParse(raw);
  if (!parsed.success) redirect(bankUrl(fallbackRole, { error: parsed.error.issues[0]?.message ?? "Invalid item" }));
  const { error } = await supabase.from("quiz_items").insert(parsed.data);
  if (error) redirect(bankUrl(parsed.data.role_slug, { error: error.message }));
  redirect(bankUrl(parsed.data.role_slug, { topic: parsed.data.topic, ok: "Item added. It can be drawn in new attempts now." }));
}
