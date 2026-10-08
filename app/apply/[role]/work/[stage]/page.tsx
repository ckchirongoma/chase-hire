import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWorkState, WorkError } from "@/lib/server/work";
import { fmtDate } from "@/lib/format";
import { renderMarkdown } from "@/lib/work/markdown";
import { isAppStage } from "@/lib/work/stages";
import { humanDuration } from "@/lib/work/time";
import type { WorkView } from "@/lib/work/types";
import WorkClient from "./work-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function AboutAssessment({ view }: { view: WorkView }) {
  const s = view.stage;
  const work = s.workWindowMs ? humanDuration(s.workWindowMs) : null;
  const open = s.openWindowMs ? humanDuration(s.openWindowMs) : null;
  return (
    <section className="card space-y-2 text-sm" aria-label="About this assessment">
      <h2 className="h2">About this assessment</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <strong>Intended effort:</strong> {s.intendedEffort}.{" "}
          {work && (
            <>
              <strong>Work window:</strong> {work} from the moment you press Start. The clock runs on our server and can&apos;t be paused.
            </>
          )}
        </li>
        {open && (
          <li>
            <strong>Open window:</strong> press Start within {open} of the assessment unlocking
            {view.attempt && !view.attempt.startedAt ? <> (by {fmtDate(view.attempt.openUntil)})</> : null}.
          </li>
        )}
        {s.wordLimit !== null && <li>Your memo can be at most {s.wordLimit.toLocaleString("en-US")} words, not counting appendices.</li>}
        {s.pageLimit !== null && <li>Your memo can be at most {s.pageLimit} pages, including diagrams.</li>}
        <li>All data in this assessment is synthetic. The client and the people in it are fictional.</li>
        <li>We will not use your work commercially, and you keep copyright.</li>
        <li>Your submission is graded with AI assistance and reviewed by people on our team. People make every decision.</li>
      </ul>
    </section>
  );
}

export default async function WorkPage({ params }: { params: Promise<{ role: string; stage: string }> }) {
  const { role: slug, stage } = await params;
  if (!isAppStage(stage)) notFound();
  const { supabase, user } = await requireUser(`/apply/${slug}/work/${stage}`);
  const { data: role } = await supabase.from("roles").select("id, slug, title").eq("slug", slug).maybeSingle();
  if (!role) notFound();

  let view: WorkView;
  try {
    view = await getWorkState(createAdminClient(), user.id, role.slug, stage, (task) =>
      after(() => task().catch((e) => console.error("work: deferred task failed", e))),
    );
  } catch (err) {
    if (err instanceof WorkError && err.status === 404) notFound();
    throw err;
  }

  const showBrief = view.status === "ready" || view.status === "active" || view.status === "submitted";
  return (
    <div className="space-y-4">
      <div>
        <h1 className="h1">{view.stage.title}</h1>
        <p className="muted -mt-3">{role.title}</p>
      </div>
      {showBrief ? (
        <>
          <AboutAssessment view={view} />
          <WorkClient initial={view} userId={user.id} brief={renderMarkdown(view.stage.briefMd)} />
        </>
      ) : (
        <div className="space-y-3">
          <p className="notice">{view.notice ?? "This assessment isn't available right now."}</p>
          <Link href="/me/results" className="btn-secondary">
            My application
          </Link>
        </div>
      )}
    </div>
  );
}
