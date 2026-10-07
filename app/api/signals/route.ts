import { NextResponse } from "next/server";
import { z } from "zod";
import { routeUser } from "@/lib/server/route";

const Signal = z.object({
  context: z.string().min(1).max(100),
  kind: z.enum(["paste_attempt", "copy_attempt", "blur", "focus", "burst_input"]),
  payload: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).default({}),
});
const Body = z.object({ signals: z.array(Signal).min(1).max(20) });

/** Client-side integrity signals. Logged only; never evidence on their own. */
export async function POST(request: Request) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { error } = await auth.supabase.from("signals").insert(parsed.data.signals);
  if (error) return NextResponse.json({ error: "Could not log" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
