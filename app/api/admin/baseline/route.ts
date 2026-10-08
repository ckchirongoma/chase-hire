import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/server/auth";
import { generateBaseline } from "@/lib/server/baseline";
import { errorResponse, routeUser } from "@/lib/server/route";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const Body = z.object({
  rubricKey: z.string().trim().regex(/^[a-z0-9_]{2,40}$/),
  version: z.number().int().positive().optional(),
});

/**
 * Admin: (re)generate a rubric's generic baseline (docs/09 §3) from its stage brief.
 * Re-run the gold set afterwards: the baseline is a grading input.
 */
export async function POST(request: Request) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  if (!(await isAdmin(auth.supabase))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    return NextResponse.json(await generateBaseline(createAdminClient(), parsed.data.rubricKey, { version: parsed.data.version }));
  } catch (err) {
    return errorResponse(err);
  }
}
