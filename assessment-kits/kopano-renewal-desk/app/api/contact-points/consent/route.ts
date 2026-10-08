import { getCaller } from "@/lib/auth";
import { errorJson, json, readJson } from "@/lib/http";
import { ConsentInput, fieldErrors } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Records what the customer said on the call: opted in to messages, or opted out (RD-05). The
 * database keeps who changed it and when, and refuses to lift an opt-out unless a manager gives a
 * reason, so this holds for any client.
 */
export async function POST(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return errorJson(401, "Sign in first.");
  const parsed = ConsentInput.safeParse(await readJson(req));
  if (!parsed.success) return errorJson(400, "Send {contactPointId, consentStatus} (and a reason of at least 5 characters to lift an opt-out).", { fields: fieldErrors(parsed.error) });
  const { contactPointId, consentStatus, reason } = parsed.data;
  const now = new Date().toISOString();
  const { data, error } = await caller.db
    .from("contact_points")
    .update({ consent_status: consentStatus, verified_at: now, updated_at: now, ...(reason ? { consent_note: reason } : {}) })
    .eq("id", contactPointId)
    .select("id, consent_status, verified_at, consent_changed_at, consent_note")
    .maybeSingle();
  if (error) {
    if (error.hint === "opt_out_locked") return errorJson(403, "This contact opted out. Only a manager can lift an opt-out.", { reason: "opt_out_locked" });
    if (error.hint === "reason_required") return errorJson(422, "Give the reason for lifting this opt-out.", { reason: "reason_required", fields: { reason: "required" } });
    return errorJson(500, "Consent could not be recorded.");
  }
  if (!data) return errorJson(404, "Contact point not found.");
  return json({ contactPoint: data });
}
