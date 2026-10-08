"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";
import { refreshScores } from "@/lib/server/scores";
import { createAdminClient } from "@/lib/supabase/admin";
import { BATCH_ELIGIBLE_STATUSES } from "./eligibility";

/**
 * Batch advance (docs/01 "Stage gates"): only applications that finished their stage and are
 * waiting for a person, only after the admin confirms "Advance N candidates", one written reason
 * recorded on every decision. There is no batch reject.
 */

const Batch = z.object({
  ids: z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.uuid()).min(1, "Select at least one candidate.").max(200, "At most 200 candidates per batch.")),
  confirm: z.coerce.number().int(),
  reason: z.string().trim().min(20, "The reason must be at least 20 characters and reference the criteria."),
  back: z.string().regex(/^\/admin\/pipeline(\?[\w=&%.-]*)?$/).optional(),
});

export async function batchAdvance(formData: FormData) {
  const { supabase } = await requireAdmin();
  const parsed = Batch.safeParse(Object.fromEntries(formData));
  const back = parsed.success && parsed.data.back ? parsed.data.back : "/admin/pipeline";
  const go = (params: Record<string, string>): never => {
    const url = new URL(back, "http://x");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    redirect(`${url.pathname}${url.search}`);
  };
  if (!parsed.success) go({ error: parsed.error.issues[0].message });
  const { ids, confirm, reason } = parsed.data!;
  const unique = [...new Set(ids)];
  if (confirm !== unique.length) go({ error: `Confirm the exact number of candidates (${unique.length}).` });

  // Re-check eligibility on the server: the board may be stale.
  const { data: apps, error } = await supabase.from("applications").select("id, status").in("id", unique);
  if (error) go({ error: error.message });
  const found = new Map((apps ?? []).map((a) => [a.id as string, a.status as string]));
  const ineligible = unique.filter((id) => !BATCH_ELIGIBLE_STATUSES.includes(found.get(id) ?? ""));
  if (ineligible.length) go({ error: `${ineligible.length} selected application(s) are not waiting for review any more. Refresh and try again.` });

  // The decision snapshot records the composite, so bring it up to date first.
  await refreshScores(createAdminClient(), unique);
  const { data: n, error: rpcErr } = await supabase.rpc("admin_batch_advance", { p_application_ids: unique, p_reason: reason });
  if (rpcErr) go({ error: rpcErr.message });
  go({ ok: `Advanced ${n} candidate${n === 1 ? "" : "s"}.` });
}
