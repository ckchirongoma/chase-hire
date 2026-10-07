import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { QuizAnswerBody, RoleSlug } from "@/lib/quiz/api-schema";
import { answerQuiz } from "@/lib/server/quiz";
import { errorResponse, routeUser } from "@/lib/server/route";

/** Submit the answer (or a skip) for the current item and receive the next one. */
export async function POST(request: Request, { params }: { params: Promise<{ role: string }> }) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const role = RoleSlug.safeParse((await params).role);
  if (!role.success) return NextResponse.json({ error: "Unknown role" }, { status: 404 });
  const parsed = QuizAnswerBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    const { attemptId, position, answer } = parsed.data;
    return NextResponse.json(await answerQuiz(createAdminClient(), auth.user.id, role.data, attemptId, position, answer));
  } catch (err) {
    return errorResponse(err);
  }
}
