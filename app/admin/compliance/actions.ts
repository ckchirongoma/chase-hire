"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";
import { countDue, lookupArchive, purgeDue, type LookupState } from "@/lib/server/retention";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * /admin/compliance actions (docs/12):
 *   - "Purge now": the same purge the nightly sweep runs, started by an admin who confirms the
 *     exact number of people due. It runs until 240 s have passed (no fixed count); unfinished
 *     purges alternate with new ones. The dry run is a plain GET of the page (?dry=1).
 *   - "Close as lapsed": idle applications still in play are closed by an admin with a written
 *     reason (admin_lapse_applications, through the admin's own client). Retention never closes
 *     an application by itself; the 6-month clock starts from this decision.
 *   - Archive lookup: what was kept after a purge for someone who disputes a decision, matched by
 *     the e-mail address they give (the server computes the HMAC; no id or hash is shown).
 */

const PurgeNow = z.object({
  confirm: z.coerce.number().int().min(0, "Type the number of people due to confirm."),
  ack: z.literal("on", { error: "Tick the box to confirm the purge can't be undone." }),
});

const back = (params: Record<string, string>, anchor = "retention"): never => {
  const q = new URLSearchParams(params);
  redirect(`/admin/compliance?${q.toString()}#${anchor}`);
};

export async function purgeNow(formData: FormData) {
  const { user } = await requireAdmin();
  const parsed = PurgeNow.safeParse(Object.fromEntries(formData));
  if (!parsed.success) back({ error: parsed.error.issues[0].message });
  // Service role only after the admin check: storage and auth deletions need it.
  const admin = createAdminClient();
  const { due, inProgress } = await countDue(admin);
  const total = due + inProgress;
  if (total === 0) back({ error: "Nobody is due for purging." });
  if (parsed.data!.confirm !== total) back({ error: `Confirm the exact number of people due (${total}).` });

  // The page allows 300 s; start no new purge after 240 s (the rest wait for the next run).
  const report = await purgeDue(admin, { triggeredBy: `admin:${user.id}`, deadline: Date.now() + 240_000 });
  const parts = [`Purged ${report.purged} ${report.purged === 1 ? "person" : "people"}.`];
  const cancelled = report.outcomes.filter((o) => o.status === "skipped" && o.reason.startsWith("cancelled")).length;
  if (cancelled) parts.push(`${cancelled} no longer due: their purge was cancelled and undone.`);
  if (report.failed) parts.push(`${report.failed} failed and stay in progress (see below); the next run retries them.`);
  if (report.remaining) parts.push(`${report.remaining} left for the next run (time ran out).`);
  if (report.lateUploads.objects) parts.push(`${report.lateUploads.objects} file(s) uploaded after an earlier purge were deleted.`);
  back({ ok: parts.join(" ") });
}

const Lapse = z.object({
  application_id: z.array(z.uuid()).min(1, "Tick at least one application to close.").max(200, "Close at most 200 at a time."),
  reason: z.string().trim().min(20, "Write a reason of at least 20 characters (the candidate sees it)."),
  ack: z.literal("on", { error: "Tick the box to confirm these applications are closed." }),
});

export async function lapseApplications(formData: FormData) {
  const { supabase } = await requireAdmin();
  const parsed = Lapse.safeParse({
    application_id: formData.getAll("application_id").map(String),
    reason: formData.get("reason") ?? "",
    ack: formData.get("ack") ?? undefined,
  });
  if (!parsed.success) back({ error: parsed.error.issues[0].message }, "stale");
  const { data, error } = await supabase.rpc("admin_lapse_applications", {
    p_application_ids: parsed.data!.application_id,
    p_reason: parsed.data!.reason,
  });
  if (error) back({ error: error.message }, "stale");
  const n = Number(data ?? 0);
  back({ ok: `Closed ${n} ${n === 1 ? "application" : "applications"} as lapsed. Their retention clock starts today.` }, "stale");
}

const Lookup = z.object({ email: z.email("Enter the e-mail address the person applied with.").max(320) });

export async function lookupDispute(_prev: LookupState, formData: FormData): Promise<LookupState> {
  const { supabase } = await requireAdmin();
  const parsed = Lookup.safeParse({ email: String(formData.get("email") ?? "").trim() });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0].message };
  try {
    return { status: "found", email: parsed.data.email, result: await lookupArchive(supabase, parsed.data.email) };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
