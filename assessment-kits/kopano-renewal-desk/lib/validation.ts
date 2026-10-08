import { z } from "zod";

export const OUTCOMES = ["call_back", "quote", "sale", "not_interested", "no_answer"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const OUTCOME_LABELS: Record<Outcome, string> = {
  call_back: "Call back",
  quote: "Quote requested",
  sale: "Sale",
  not_interested: "Not interested",
  no_answer: "No answer",
};

const OutcomeFields = z.object({
  customerId: z.uuid(),
  outcome: z.enum(OUTCOMES),
  nextActionAt: z.iso.datetime({ offset: true }).nullish(),
  notes: z.string().trim().max(2000).nullish(),
});

/** RD-07: a call back must carry a callback date, and it must be in the future. */
function requireCallbackDate(v: z.infer<typeof OutcomeFields>, ctx: z.RefinementCtx) {
  if (v.outcome !== "call_back") return;
  if (!v.nextActionAt) {
    ctx.addIssue({ code: "custom", path: ["nextActionAt"], message: "A call back needs a callback date and time." });
  } else if (new Date(v.nextActionAt).getTime() <= Date.now()) {
    ctx.addIssue({ code: "custom", path: ["nextActionAt"], message: "The callback date must be in the future." });
  }
}

export const OutcomeInput = OutcomeFields.superRefine(requireCallbackDate);
export type OutcomeInput = z.infer<typeof OutcomeInput>;

export const MessageInput = z.object({
  customerId: z.uuid(),
  templateId: z.uuid(),
});

export const ConsentInput = z.object({
  contactPointId: z.uuid(),
  consentStatus: z.enum(["opted_in", "opted_out"]),
});

export const AllocationInput = z.object({
  customerId: z.uuid(),
  agentId: z.uuid(),
});

export const SummaryInput = z.object({
  customerId: z.uuid(),
  question: z.string().trim().max(500).optional(),
});

/** First issue per field, for API error bodies. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "body";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
