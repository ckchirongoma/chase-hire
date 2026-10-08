import { getCaller } from "@/lib/auth";
import { errorJson, json, readJson } from "@/lib/http";
import { OutcomeInput, fieldErrors } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Logs a call outcome for one of the caller's customers (RD-06, RD-07). */
export async function POST(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return errorJson(401, "Sign in first.");
  const parsed = OutcomeInput.safeParse(await readJson(req));
  if (!parsed.success) return errorJson(422, "The outcome is not valid.", { fields: fieldErrors(parsed.error) });
  const input = parsed.data;

  const { data: customer } = await caller.db.from("customers").select("id").eq("id", input.customerId).maybeSingle();
  if (!customer) return errorJson(404, "Customer not found.");

  const { data, error } = await caller.db
    .from("interactions")
    .insert({
      customer_id: input.customerId,
      agent_id: caller.userId,
      outcome: input.outcome,
      next_action_at: input.nextActionAt ?? null,
      notes: input.notes || null,
    })
    .select("id, customer_id, agent_id, outcome, next_action_at, notes, created_at")
    .single();
  if (error) {
    if (error.code === "23514") return errorJson(422, "A call back needs a callback date in the future.", { fields: { nextActionAt: "required" } });
    if (error.code === "42501") return errorJson(403, "You can only log outcomes for your own customers.");
    return errorJson(500, "The outcome could not be saved.");
  }
  return json({ interaction: data }, 201);
}

/** The interaction history of one customer the caller can see. */
export async function GET(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return errorJson(401, "Sign in first.");
  const customerId = new URL(req.url).searchParams.get("customerId") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(customerId)) return errorJson(400, "Pass ?customerId=<uuid>.");
  const { data: customer } = await caller.db.from("customers").select("id").eq("id", customerId).maybeSingle();
  if (!customer) return errorJson(404, "Customer not found.");
  const { data } = await caller.db
    .from("interactions")
    .select("id, customer_id, agent_id, outcome, next_action_at, notes, created_at")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false });
  return json({ interactions: data ?? [] });
}
