import Link from "next/link";
import { redirect } from "next/navigation";
import { getCandidateState, requireUser } from "@/lib/server/auth";
import { settings } from "@/lib/config";
import { ReasoningResultCard } from "@/components/stars";
import Runner from "./runner";

export const dynamic = "force-dynamic";

export default async function ReasoningPage() {
  const { supabase, user } = await requireUser("/assess/reasoning");
  const state = await getCandidateState(supabase, user.id);
  if (!state.consented) redirect("/consent");
  if (state.cvStatus !== "parsed") redirect("/profile");

  const a = state.reasoning;
  const inProgress = a && !a.submitted_at;
  const done = a?.submitted_at && a.stars != null;

  if (done) {
    const nextDate = new Date(new Date(a.started_at).getTime() + settings.reasoning.retakeDays * 86_400_000);
    return (
      <div className="space-y-4">
        <h1 className="h1">Reasoning Assessment</h1>
        <ReasoningResultCard rawScore={a.raw_score ?? 0} percentile={Number(a.percentile)} stars={a.stars!} normVersion={a.norm_version} />
        <p className="muted">You can retake the assessment from {nextDate.toLocaleDateString("en-ZA")}.</p>
        <p className="text-sm">
          Take a break if you like. When you apply to a role, the next step is a spoken AI interview about your CV (about 25
          to 30 minutes). It only starts when you press Start, so you can apply now and do it later.
        </p>
        <div className="flex gap-3">
          <Link href="/roles" className="btn">Apply to a role</Link>
          <Link href="/me/results" className="btn-secondary">My application</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="h1">Reasoning Assessment</h1>
      {!inProgress && (
        <div className="card space-y-2 text-sm">
          <p>30 questions in 15 minutes. It tests job-related problem solving: number and letter patterns, reading business tables, logical ordering, short verbal items and word problems.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>One question at a time. You can&apos;t go back, but you can skip. Skipped questions count as wrong.</li>
            <li>The clock runs on our server. If your connection drops, log back in; the clock keeps running.</li>
            <li>Use keys 1–5 to choose and Enter to confirm. Paper and a calculator are fine.</li>
            <li>You can take it once every 90 days. Find a quiet 15 minutes before you start.</li>
            <li>Stay on this page until you finish. Leaving it once pauses the test; leaving it a second time locks it until our team reopens it (not a rejection).</li>
          </ul>
        </div>
      )}
      <Runner resume={!!inProgress} />
    </div>
  );
}
