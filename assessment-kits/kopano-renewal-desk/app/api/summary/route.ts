import { getCaller } from "@/lib/auth";
import { errorJson, json, readJson } from "@/lib/http";
import { AiNotConfiguredError, chatCompletion } from "@/lib/openrouter";
import { retryAfterSeconds, takeRateLimit } from "@/lib/rate-limit";
import { buildSummaryMessages, loadSummaryContext } from "@/lib/summary";
import { SummaryInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Per-user caps on the paid AI call (documented in the README). */
const PER_MINUTE = 5;
const PER_DAY = 60;

export async function POST(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return errorJson(401, "Sign in to use the AI summary.");
  for (const [bucket, limit, windowSeconds] of [["summary:minute", PER_MINUTE, 60], ["summary:day", PER_DAY, 86_400]] as const) {
    const rl = await takeRateLimit(caller.db, bucket, limit, windowSeconds);
    if (!rl.allowed) {
      return errorJson(429, `You have used the AI summary ${limit} times in this period. Try again later.`, { limit, reset_at: rl.resetAt }, { "Retry-After": retryAfterSeconds(rl.resetAt) });
    }
  }

  const parsed = SummaryInput.safeParse(await readJson(req));
  if (!parsed.success) return errorJson(400, "Send {customerId} and, optionally, a short question.");
  const ctx = await loadSummaryContext(caller.db, parsed.data.customerId);
  if (!ctx) return errorJson(404, "Customer not found.");

  try {
    const result = await chatCompletion(buildSummaryMessages(ctx, parsed.data.question));
    return json({ summary: result.text, model: result.model });
  } catch (err) {
    if (err instanceof AiNotConfiguredError) return errorJson(503, "The AI summary is not configured on this server.");
    return errorJson(502, "The AI service did not answer. Try again in a minute.");
  }
}
