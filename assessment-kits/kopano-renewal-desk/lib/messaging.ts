/**
 * RD-11: who may be sent which template. The database trigger on message_queue enforces the same
 * rules; this module gives the app a clear reason to show before it tries.
 */

export type ConsentStatus = "opted_in" | "existing_customer_s69_3" | "opted_out" | "unknown";
export type BlockReason = "opted_out" | "template_not_approved" | "no_consented_contact";

export interface ContactPointLite {
  id: string;
  type: "mobile" | "landline" | "email" | "whatsapp";
  consent_status: ConsentStatus;
  verified_at: string | null;
}

export interface TemplateLite {
  approved: boolean;
  category: "utility" | "marketing";
}

export const BLOCK_MESSAGES: Record<BlockReason, string> = {
  opted_out: "This customer is on Legal's opt-out list. No message can be queued.",
  template_not_approved: "Only templates the Network has approved can be used.",
  no_consented_contact: "This customer has no mobile, WhatsApp or email contact with consent for this template.",
};

/** A contact point that may receive this template: an explicit opt-in, or (utility only) the existing-customer basis. */
export function canReceive(c: ContactPointLite, category: TemplateLite["category"]): boolean {
  if (c.type === "landline") return false;
  if (c.consent_status === "opted_in") return true;
  return category === "utility" && c.consent_status === "existing_customer_s69_3";
}

export function pickContactPoint(contacts: ContactPointLite[], category: TemplateLite["category"]): ContactPointLite | null {
  const rank = (c: ContactPointLite) => (c.consent_status === "opted_in" ? 0 : 1) * 10 + (c.type === "whatsapp" ? 0 : c.type === "mobile" ? 1 : 2);
  return contacts.filter((c) => canReceive(c, category)).sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

export function messageBlockReason(input: { optedOut: boolean; template: TemplateLite | null; contacts: ContactPointLite[] }): BlockReason | null {
  if (input.optedOut) return "opted_out";
  if (!input.template || !input.template.approved) return "template_not_approved";
  if (!pickContactPoint(input.contacts, input.template.category)) return "no_consented_contact";
  return null;
}
