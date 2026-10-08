import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { CvError, processCv } from "@/lib/server/cv";

export const maxDuration = 120;

const Body = z.object({ path: z.string().min(3).max(300), fileName: z.string().min(1).max(200) });

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const { data: consent } = await supabase.from("consents").select("id").eq("user_id", user.id).limit(1);
  if (!consent?.length) return NextResponse.json({ error: "Please accept the privacy notice first" }, { status: 403 });

  try {
    const result = await processCv(createAdminClient(), user.id, parsed.data.path, parsed.data.fileName);
    if (result.status === "failed") {
      return NextResponse.json({ error: "We could not read that CV. Please try a text-based PDF or .docx." }, { status: 422 });
    }
    return NextResponse.json({ status: result.status });
  } catch (err) {
    if (err instanceof CvError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error(err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
