import { getCaller } from "@/lib/auth";
import { errorJson, json, readJson } from "@/lib/http";
import { BLOCK_MESSAGES, messageBlockReason, type BlockReason, type ContactPointLite, type TemplateLite } from "@/lib/messaging";
import { MessageInput, fieldErrors } from "@/lib/validation";

export const dynamic = "force-dynamic";

const STATUS_FOR: Record<BlockReason, number> = { opted_out: 409, template_not_approved: 422, no_consented_contact: 422 };

/** Queues a templated message (RD-10, RD-11). Nothing is sent from the Desk. */
export async function POST(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return errorJson(401, "Sign in first.");
  const parsed = MessageInput.safeParse(await readJson(req));
  if (!parsed.success) return errorJson(400, "Send {customerId, templateId}.", { fields: fieldErrors(parsed.error) });
  const { customerId, templateId } = parsed.data;

  const { data: customer } = await caller.db.from("customers").select("id").eq("id", customerId).maybeSingle();
  if (!customer) return errorJson(404, "Customer not found.");
  const { data: template } = await caller.db.from("templates").select("id, approved, category").eq("id", templateId).maybeSingle();
  if (!template) return errorJson(404, "Template not found.");

  const [{ data: optedOut }, { data: contacts }] = await Promise.all([
    caller.db.rpc("customer_opted_out", { p_customer_id: customerId }),
    caller.db.from("contact_points").select("id, type, consent_status, verified_at").eq("customer_id", customerId),
  ]);
  const reason = messageBlockReason({ optedOut: optedOut === true, template: template as TemplateLite, contacts: (contacts ?? []) as ContactPointLite[] });
  if (reason) return errorJson(STATUS_FOR[reason], BLOCK_MESSAGES[reason], { reason });

  const { data, error } = await caller.db
    .from("message_queue")
    .insert({ customer_id: customerId, template_id: templateId, created_by: caller.userId })
    .select("id, customer_id, template_id, contact_point_id, channel, status, created_at")
    .single();
  if (error) {
    const hint = (error.hint ?? "") as BlockReason;
    if (hint in STATUS_FOR) return errorJson(STATUS_FOR[hint], BLOCK_MESSAGES[hint], { reason: hint });
    if (error.code === "42501") return errorJson(403, "You can only message your own customers.");
    return errorJson(500, "The message could not be queued.");
  }
  return json({ message: data }, 201);
}
