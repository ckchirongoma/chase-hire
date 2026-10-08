import { after, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { AUDIO_TYPES, InterviewConflict, MAX_AUDIO_BYTES, postInterviewAudio } from "@/lib/server/interview";
import { errorResponse, routeUser } from "@/lib/server/route";

// Transcription + the next question + (for the last answer) grading kicked off after the response.
export const maxDuration = 300;

const Fields = z.object({
  turn: z.coerce.number().int().min(0),
  durationMs: z.coerce.number().int().min(0).max(10 * 60_000).nullable(),
});

/** A spoken answer (multipart: audio, turn, durationMs). Returns the interview state. */
export async function POST(request: Request, { params }: { params: Promise<{ applicationId: string }> }) {
  const auth = await routeUser();
  if (auth instanceof NextResponse) return auth;
  const { applicationId } = await params;
  if (!z.uuid().safeParse(applicationId).success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  const fields = Fields.safeParse({ turn: form?.get("turn"), durationMs: form?.get("durationMs") ?? null });
  if (!form || !(audio instanceof Blob) || !fields.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const mime = (audio.type || "").split(";")[0].toLowerCase();
  if (!AUDIO_TYPES[mime]) return NextResponse.json({ error: "Unsupported audio format" }, { status: 400 });
  if (audio.size === 0 || audio.size > MAX_AUDIO_BYTES) return NextResponse.json({ error: "The recording is empty or too long" }, { status: 400 });

  try {
    const state = await postInterviewAudio(
      createAdminClient(),
      auth.user.id,
      applicationId,
      { turn: fields.data.turn, audio: Buffer.from(await audio.arrayBuffer()), mime, durationMs: fields.data.durationMs },
      (task) => after(() => task().catch((e) => console.error("interview grading failed", e))),
    );
    return NextResponse.json(state);
  } catch (err) {
    if (err instanceof InterviewConflict) return NextResponse.json({ error: err.message, state: err.state }, { status: 409 });
    return errorResponse(err);
  }
}
