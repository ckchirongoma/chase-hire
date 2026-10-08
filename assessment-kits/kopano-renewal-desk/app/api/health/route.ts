import { json } from "@/lib/http";
import { createAnonClient } from "@/lib/supabase/anon";

export const dynamic = "force-dynamic";

/** Liveness plus a real database round trip. */
export async function GET() {
  try {
    const { data, error } = await createAnonClient().rpc("health_check");
    if (error) return json({ ok: false, db: "error" }, 503);
    return json({ ok: true, db: "ok", time: (data as { time?: string } | null)?.time ?? null });
  } catch {
    return json({ ok: false, db: "unreachable" }, 503);
  }
}
