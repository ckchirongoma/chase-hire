"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";
import { refreshQuietly, refreshScores } from "@/lib/server/scores";
import { createAdminClient } from "@/lib/supabase/admin";
import { cleanScores, formatNotes, isScoredKind, kindsForRole, scorecardTotal, type ScoredKind } from "@/lib/live/scorecard";
import { deltaNeedsDiscussion, LIVE_ITEM_COUNT } from "@/lib/live/retest";
import { LIVE_STAGES, loadApplication, questionsFor, recordedRetest } from "@/lib/server/live";

/**
 * Live-stage writes (docs/09 §2 and §5). Scorecards are written through the admin's own client,
 * so RLS applies (a rater only ever writes their own card) and the DB guard makes a submitted card
 * final. Raters score independently: nothing here reads another rater's card. A retest delta is a
 * signal for discussion in the room, never a rejection; only an admin decision changes status.
 */

const FINAL = "This scorecard is submitted and final. It can't be edited.";

/** Plain-language messages for the scorecard guard's errors (migration 0019). */
function guardMessage(m: string): string {
  if (/scorecard_already_submitted/.test(m)) return FINAL;
  if (/application_not_at_live_stage/.test(m)) return "This application is not at the shortlist or live stage.";
  if (/scorecard_questions_mismatch/.test(m)) return "The questions on this card changed (the bank or the candidate's verification concerns): reload the page and score again.";
  if (/scorecard_scores_missing/.test(m)) return "Score every question before submitting.";
  if (/scorecard_scores_invalid/.test(m)) return "Scores must be whole numbers from 1 to 5, for this card's questions only.";
  if (/scorecard_kind_not_for_role|scorecard_kind_unsupported/.test(m)) return "This application's role has no such scorecard.";
  return m;
}

const go = (path: string, params: Record<string, string>, hash = ""): never => {
  const q = new URLSearchParams(params);
  redirect(`${path}?${q}${hash ? `#${hash}` : ""}`);
};

const Card = z.object({
  application_id: z.uuid(),
  kind: z.string().refine(isScoredKind, "Unknown scorecard."),
  intent: z.enum(["draft", "submit"]),
});

export async function saveScorecard(formData: FormData) {
  const { supabase, user } = await requireAdmin();
  const parsed = Card.safeParse({ application_id: formData.get("application_id"), kind: formData.get("kind"), intent: formData.get("intent") });
  if (!parsed.success) go("/admin/live", { error: "Invalid scorecard." });
  const { application_id: appId, intent } = parsed.data!;
  const kind = parsed.data!.kind as ScoredKind;
  const back = `/admin/live/${appId}`;

  const app = await loadApplication(supabase, appId);
  if (!app) go("/admin/live", { error: "Application not found." });
  if (!(LIVE_STAGES as readonly string[]).includes(app!.stage)) go(back, { error: "This application is not at the shortlist or live stage." }, kind);
  const role = app!.roles?.slug ?? "";
  if (!kindsForRole(role).includes(kind)) go(back, { error: `A ${role || "this"} application has no ${kind} scorecard.` }, kind);

  const { byKind } = await questionsFor(supabase, role, appId);
  const keys = (byKind.get(kind) ?? []).map((q) => q.key);
  if (!keys.length) go(back, { error: "No questions in the bank for this scorecard." }, kind);

  const field = (name: string) => {
    const v = formData.get(name);
    return typeof v === "string" ? v : "";
  };
  const { scores, missing, invalid } = cleanScores(Object.fromEntries(keys.map((k) => [k, field(`score:${k}`)])), keys);
  if (invalid.length) go(back, { error: `Scores must be whole numbers from 1 to 5 (${invalid.join(", ")}).` }, kind);
  if (intent === "submit" && missing.length) go(back, { error: `Score every question before submitting (missing: ${missing.join(", ")}).` }, kind);

  const notes = formatNotes(Object.fromEntries(keys.map((k) => [k, field(`note:${k}`).slice(0, 4000)])), field("notes").slice(0, 8000), keys);
  // The database recomputes the total on submit (migration 0019) and checks the scores against
  // the card's questions; the value here is what the page shows until then.
  const row = {
    scores,
    question_keys: keys,
    total: scorecardTotal(scores, keys),
    notes,
    submitted_at: intent === "submit" ? new Date().toISOString() : null,
  };

  const { data: mine, error: readErr } = await supabase
    .from("live_scorecards")
    .select("id, submitted_at")
    .eq("application_id", appId)
    .eq("kind", kind)
    .eq("rater", user.id)
    .maybeSingle();
  if (readErr) go(back, { error: readErr.message }, kind);
  if (mine?.submitted_at) go(back, { error: FINAL }, kind);

  const write = mine
    ? await supabase.from("live_scorecards").update(row).eq("id", mine.id).select("id")
    : await supabase.from("live_scorecards").insert({ application_id: appId, kind, ...row }).select("id");
  if (write.error) go(back, { error: guardMessage(write.error.message) }, kind);
  if (!write.data?.length) go(back, { error: "The scorecard was not saved." }, kind);

  if (intent === "submit") {
    // final = 50% pre-live + 50% live once every live kind has a submitted card (lib/scoring).
    await refreshQuietly(refreshScores(createAdminClient(), [appId]));
    go(back, { ok: "Scorecard submitted. You can now see the other panellists' submitted scorecards for this part." }, kind);
  }
  go(back, { ok: "Draft saved. Only you can see it until you submit." }, kind);
}

// ───────────────────────── Reasoning retest ─────────────────────────

const RAW_MSG = `Enter the raw score: a whole number from 0 to ${LIVE_ITEM_COUNT}.`;
const RETEST_FINAL = "A retest is already recorded for this candidate, and it is final (one retest per candidate).";
const Retest = z.object({
  application_id: z.uuid(),
  raw: z
    .string()
    .trim()
    .regex(/^\d{1,2}$/, RAW_MSG)
    .transform(Number)
    .pipe(z.number().int().min(0, RAW_MSG).max(LIVE_ITEM_COUNT, RAW_MSG)),
  seed: z
    .string()
    .regex(/^\d{1,10}$/, "The form's seed is missing: reload the retest page.")
    .transform(Number)
    .pipe(z.number().int().min(1).max(2 ** 31 - 1)),
});

/**
 * Records the paper retest: raw 0–12 → live percentile (live norm) → live_delta = online − live.
 * One retest per candidate, stored as a final reasoning_retest scorecard; the database derives the
 * percentiles and the delta from the raw score and sets applications.live_delta (migration 0019).
 * A delta above 25 logs a live_delta signal FOR DISCUSSION. Not part of any composite (docs/09 §2).
 */
export async function recordRetest(formData: FormData) {
  const { supabase } = await requireAdmin();
  const appIdRaw = String(formData.get("application_id") ?? "");
  const seedRaw = String(formData.get("seed") ?? "");
  const parsed = Retest.safeParse({ application_id: appIdRaw, raw: String(formData.get("raw") ?? ""), seed: seedRaw });
  const back = z.uuid().safeParse(appIdRaw).success ? `/admin/live/${appIdRaw}/retest` : "/admin/live";
  // Errors go back to the SAME printed form (its seed), so the recorded seed matches the paper.
  const keep: Record<string, string> = /^\d{1,10}$/.test(seedRaw) ? { seed: seedRaw } : {};
  const fail = (error: string): never => go(back, { error, ...keep });
  if (!parsed.success) fail(parsed.error.issues[0].message);
  const { application_id: appId, raw, seed } = parsed.data!;

  const app = await loadApplication(supabase, appId);
  if (!app) go("/admin/live", { error: "Application not found." });
  if (!(LIVE_STAGES as readonly string[]).includes(app!.stage)) fail("This application is not at the shortlist or live stage.");

  // One retest per candidate (DB guard): the first recorded count is the result, so live_delta
  // and its signal can't be silently replaced by a second entry.
  const service = createAdminClient();
  if (await recordedRetest(service, appId)) fail(RETEST_FINAL);

  const write = await supabase
    .from("live_scorecards")
    .insert({ application_id: appId, kind: "reasoning_retest", scores: { raw, seed }, notes: null, submitted_at: new Date().toISOString() })
    .select("id");
  if (write.error) {
    const m = write.error.message;
    fail(/retest_already_recorded|scorecard_already_submitted|duplicate key/.test(m) ? RETEST_FINAL : /application_not_at_live_stage/.test(m) ? "This application is not at the shortlist or live stage." : m);
  }
  // What the database recorded (percentiles and delta derived from the raw score).
  const recorded = await recordedRetest(service, appId);
  if (!recorded || recorded.livePercentile === null) fail("The retest was not recorded.");
  const { livePercentile: live, onlinePercentile: online, delta, normVersion } = recorded!;

  if (deltaNeedsDiscussion(delta)) {
    const { error: sigErr } = await service.from("signals").insert({
      user_id: app!.user_id,
      context: "live_retest",
      kind: "live_delta",
      payload: { application_id: appId, online_percentile: online, live_percentile: live, delta, raw, seed, norm_version: normVersion },
    });
    if (sigErr) console.warn("could not log live_delta signal", sigErr.message);
  }

  const summary =
    delta === null
      ? `Retest recorded: ${raw}/${LIVE_ITEM_COUNT}, live percentile ${live}. No online attempt to compare with.`
      : `Retest recorded: ${raw}/${LIVE_ITEM_COUNT}, live percentile ${live}, delta ${delta}.${deltaNeedsDiscussion(delta) ? " Flagged for discussion in the room (not a rejection)." : ""}`;
  go(back, { ok: summary, seed: String(seed) });
}

// ───────────────────────── Bank ─────────────────────────

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const Question = z.object({
  id: z.uuid(),
  text: z.string().trim().min(10, "The question needs at least 10 characters.").max(1000),
  probes: z
    .string()
    .max(4000)
    .transform(lines)
    .pipe(z.array(z.string().max(400)).max(12, "At most 12 probes.")),
  anchor1: z.string().trim().min(3, "Every anchor (1, 3, 5) needs text.").max(600),
  anchor3: z.string().trim().min(3, "Every anchor (1, 3, 5) needs text.").max(600),
  anchor5: z.string().trim().min(3, "Every anchor (1, 3, 5) needs text.").max(600),
  active: z.enum(["on"]).optional(),
  replaceable: z.enum(["on"]).optional(),
});

/** Edits one bank question (docs/09 §5: anchors live in the bank). Applies to cards rendered from now on. */
export async function updateLiveQuestion(formData: FormData) {
  const { supabase } = await requireAdmin();
  const parsed = Question.safeParse(Object.fromEntries(formData));
  if (!parsed.success) go("/admin/live/bank", { error: parsed.error.issues[0].message });
  const d = parsed.data!;
  const { data, error } = await supabase
    .from("live_questions")
    .update({ text: d.text, probes: d.probes, anchors: { "1": d.anchor1, "3": d.anchor3, "5": d.anchor5 }, active: d.active === "on", replaceable: d.replaceable === "on" })
    .eq("id", d.id)
    .select("key");
  if (error) go("/admin/live/bank", { error: error.message });
  if (!data?.length) go("/admin/live/bank", { error: "Question not found." });
  go("/admin/live/bank", { ok: `Saved ${data![0].key}.` }, data![0].key);
}
