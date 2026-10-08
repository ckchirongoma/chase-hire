import { getCaller } from "@/lib/auth";
import { errorJson, json, readJson } from "@/lib/http";
import { ConsentInput, fieldErrors } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Records what the customer said on the call: opted in to messages, or opted out (RD-05). */
export async function POST(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return errorJson(401, "Sign in first.");
  const parsed = ConsentInput.safeParse(await readJson(req));
  if (!parsed.success) return errorJson(400, "Send {contactPointId, consentStatus}.", { fields: fieldErrors(parsed.error) });
  const { data, error } = await caller.db
    .from("contact_points")
    .update({ consent_status: parsed.data.consentStatus, verified_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", parsed.data.contactPointId)
    .select("id, consent_status, verified_at")
    .maybeSingle();
  if (error) return errorJson(500, "Consent could not be recorded.");
  if (!data) return errorJson(404, "Contact point not found.");
  return json({ contactPoint: data });
}
