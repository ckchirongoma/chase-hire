import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/server/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getQuizState, QuizError, type QuizState } from "@/lib/server/quiz";
import { RoleSlug } from "@/lib/quiz/api-schema";
import { QUIZ_DURATION_MS, QUIZ_ITEM_COUNT } from "@/lib/quiz/blueprint";
import { STAGE_LABEL, STATUS_LABEL } from "@/lib/format";
import Runner from "./runner";

export const dynamic = "force-dynamic";

export default async function QuizPage({ params }: { params: Promise<{ role: string }> }) {
  const slug = RoleSlug.safeParse((await params).role);
  if (!slug.success) notFound();
  const role = slug.data;
  const { supabase, user } = await requireUser(`/apply/${role}/quiz`);

  const { data: roleRow } = await supabase.from("roles").select("id, title").eq("slug", role).maybeSingle();
  if (!roleRow) notFound();
  const { data: app } = await supabase
    .from("applications")
    .select("stage, status")
    .eq("role_id", roleRow.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!app) {
    return (
      <div className="space-y-4">
        <h1 className="h1">{roleRow.title}: role quiz</h1>
        <p className="notice">
          You haven&apos;t applied for this role yet. <Link href={`/roles/${role}`} className="underline">See the role</Link>
        </p>
      </div>
    );
  }

  // Service role after the auth check above; scoped to this user's own application.
  let state: QuizState;
  try {
    state = await getQuizState(createAdminClient(), user.id, role);
  } catch (err) {
    if (!(err instanceof QuizError) || err.status >= 500) throw err;
    return (
      <div className="space-y-4">
        <h1 className="h1">{roleRow.title}: role quiz</h1>
        <p className="notice">{err.message}</p>
        <Link href={`/apply/${role}/quiz`} className="btn-secondary">Try again</Link>
      </div>
    );
  }

  if (state.status === "none" && !state.canStart) {
    return (
      <div className="space-y-4">
        <h1 className="h1">{roleRow.title}: role quiz</h1>
        <div className="card space-y-2 text-sm">
          <p>
            The role quiz isn&apos;t open for your application right now. Your application is at{" "}
            <strong>{STAGE_LABEL[app.stage] ?? app.stage}</strong> (
            {(STATUS_LABEL[app.status] ?? app.status).toLowerCase()}).
          </p>
          {app.stage === "interview" && <p>The quiz opens as soon as you finish the AI CV interview.</p>}
        </div>
        <Link href="/me/results" className="btn-secondary">My results</Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="h1">{roleRow.title}: role quiz</h1>
      <Runner role={role} initial={state} itemCount={QUIZ_ITEM_COUNT} minutes={QUIZ_DURATION_MS / 60_000} />
    </div>
  );
}
