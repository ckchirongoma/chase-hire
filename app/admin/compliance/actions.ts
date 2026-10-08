"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";
import { countDue, purgeDue, RETENTION_SWEEP_LIMIT } from "@/lib/server/retention";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * "Purge now" on /admin/compliance: the same purge the nightly sweep runs (docs/12), started by
 * an admin who confirms the exact number of people due. At most 25 per click; unfinished purges
 * are finished first. The dry run is a plain GET of the page (?dry=1) and writes nothing.
 */

const PurgeNow = z.object({
  confirm: z.coerce.number().int().min(0, "Type the number of people due to confirm."),
  ack: z.literal("on", { error: "Tick the box to confirm the purge can't be undone." }),
});

const back = (params: Record<string, string>): never => {
  const q = new URLSearchParams(params);
  redirect(`/admin/compliance?${q.toString()}#retention`);
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

  const report = await purgeDue(admin, { limit: RETENTION_SWEEP_LIMIT, triggeredBy: `admin:${user.id}` });
  const parts = [`Purged ${report.purged} ${report.purged === 1 ? "person" : "people"}.`];
  if (report.failed) parts.push(`${report.failed} failed and stay in progress (see below); the next run retries them.`);
  if (report.remaining) parts.push(`${report.remaining} left for the next run.`);
  back({ ok: parts.join(" ") });
}
