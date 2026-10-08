import { getCaller } from "@/lib/auth";
import { errorJson, json, readJson } from "@/lib/http";
import { AllocationInput, fieldErrors } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** A manager (re)allocates a customer to an agent (RD-09). */
export async function POST(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return errorJson(401, "Sign in first.");
  if (!caller.isManager) return errorJson(403, "Only a manager can allocate customers.");
  const parsed = AllocationInput.safeParse(await readJson(req));
  if (!parsed.success) return errorJson(400, "Send {customerId, agentId}.", { fields: fieldErrors(parsed.error) });
  const { data, error } = await caller.db
    .from("allocations")
    .upsert({ customer_id: parsed.data.customerId, agent_id: parsed.data.agentId, allocated_by: caller.userId, allocated_at: new Date().toISOString() }, { onConflict: "customer_id" })
    .select("customer_id, agent_id, allocated_at")
    .single();
  if (error) return errorJson(error.code === "23503" ? 404 : 500, error.code === "23503" ? "Unknown customer or agent." : "The allocation could not be saved.");
  return json({ allocation: data });
}
