import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/server/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { STAGE_LABEL, STATUS_LABEL } from "@/lib/format";
import InterviewChat from "./chat";

export const dynamic = "force-dynamic";

export default async function InterviewPage({ params }: { params: Promise<{ role: string }> }) {
  const { role: slug } = await params;
  const { supabase, user } = await requireUser(`/apply/${slug}/interview`);

  const { data: role } = await supabase.from("roles").select("id, slug, title").eq("slug", slug).maybeSingle();
  if (!role) notFound();
  const { data: app } = await supabase
    .from("applications")
    .select("id, stage, status")
    .eq("user_id", user.id)
    .eq("role_id", role.id)
    .maybeSingle();

  const header = (
    <>
      <h1 className="h1">AI CV interview</h1>
      <p className="muted -mt-3 mb-2">{role.title}</p>
    </>
  );

  if (!app) {
    return (
      <div className="space-y-4">
        {header}
        <div className="card space-y-3 text-sm">
          <p>You haven&apos;t applied for this role yet.</p>
          <Link href={`/roles/${role.slug}`} className="btn">See the role</Link>
        </div>
      </div>
    );
  }

  // interview_sessions is admin-only under RLS; read it server-side after the auth check above.
  const { data: session } = await createAdminClient()
    .from("interview_sessions")
    .select("id, ended_at")
    .eq("application_id", app.id)
    .maybeSingle();

  if (!session) {
    let blocked: string | null = null;
    if (app.stage !== "interview") blocked = `This application is at the ${STAGE_LABEL[app.stage] ?? app.stage} stage, so the interview is closed.`;
    else if (app.status === "awaiting_review")
      blocked =
        "A person on our team is reviewing your application before the interview opens. This is not a rejection; we'll email you when it's your turn.";
    else if (app.status !== "in_progress" && app.status !== "advanced")
      blocked = `The interview isn't available for this application (${STATUS_LABEL[app.status] ?? app.status}).`;
    if (blocked) {
      return (
        <div className="space-y-4">
          {header}
          <p className="notice">{blocked}</p>
          <Link href="/me/results" className="btn-secondary">My results</Link>
        </div>
      );
    }
  }

  return (
    <div className="space-y-4">
      {header}
      {!session && (
        <div className="card space-y-2 text-sm">
          <p>
            A short, structured text interview about the work on your CV. It checks that the claims on your CV are your own
            work and how you approach problems in this role.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>6 questions, about 20 minutes. Some answers get a short follow-up question.</li>
            <li>There is a hard limit of 25 minutes. The clock runs on our server and keeps running if you leave.</li>
            <li>Paste is turned off, so type your answers. Notes on paper are fine.</li>
            <li>Be specific: say what you personally did, and name the tools, numbers and decisions.</li>
            <li>The interviewer won&apos;t comment on your answers. People on our team review the results; nothing is decided automatically.</li>
          </ul>
        </div>
      )}
      <InterviewChat applicationId={app.id} roleSlug={role.slug} resume={!!session} />
    </div>
  );
}
