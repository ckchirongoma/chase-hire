import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { finaliseExpiredQuizzes } from "@/lib/server/quiz";
import { createAdminClient } from "@/lib/supabase/admin";
import { ReasoningResultCard } from "@/components/stars";
import { ApplicationCard } from "@/components/results/application-card";
import { REVIEW_STAGE_LABEL } from "@/components/results/labels";
import { MyResults, type ApplicationResult } from "@/components/results/schema";
import { fmtDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const ReviewForm = z.object({
  // "<stage>:" for account-level results, "<stage>:<application id>" for an application.
  target: z.string().regex(/^(reasoning|cv|interview|quiz|decision):([0-9a-f-]{36})?$/),
  message: z.string().trim().min(10).max(4000),
});

async function requestReview(formData: FormData) {
  "use server";
  const { supabase } = await requireUser("/me/results");
  const parsed = ReviewForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/me/results?error=Please write at least 10 characters.");
  const [stage, applicationId] = parsed.data.target.split(":");
  const perApplication = stage === "interview" || stage === "quiz" || stage === "decision";
  if (perApplication !== !!applicationId) redirect("/me/results?error=Please choose what you would like us to review.");
  // RLS checks that the application belongs to the signed-in user.
  const { error } = await supabase.from("review_requests").insert({
    stage,
    application_id: applicationId || null,
    message: parsed.data.message,
  });
  if (error) redirect(`/me/results?error=${encodeURIComponent("Could not send your request.")}`);
  redirect("/me/results?sent=1");
}

function reviewTargets(applications: ApplicationResult[]) {
  const targets = [
    { value: "reasoning:", label: "Reasoning Assessment" },
    { value: "cv:", label: "CV reading" },
  ];
  for (const a of applications) {
    if (a.interview) targets.push({ value: `interview:${a.application_id}`, label: `${a.role_title}: AI CV interview` });
    if (a.quiz) targets.push({ value: `quiz:${a.application_id}`, label: `${a.role_title}: role quiz` });
    targets.push({ value: `decision:${a.application_id}`, label: `${a.role_title}: application decision` });
  }
  return targets;
}

export default async function ResultsPage({ searchParams }: { searchParams: Promise<{ error?: string; sent?: string }> }) {
  const { supabase, user } = await requireUser("/me/results");
  // A quiz the candidate left past its deadline is finalised now (the cron sweep does this
  // too), so the score shows here. Service role after the auth check, scoped to this user.
  try {
    await finaliseExpiredQuizzes(createAdminClient(), { userId: user.id });
  } catch (err) {
    console.error("finaliseExpiredQuizzes", err);
  }
  const [{ data: attempts }, results, { data: reviews }] = await Promise.all([
    supabase.from("my_reasoning").select("*").not("submitted_at", "is", null).order("started_at", { ascending: false }).limit(1),
    supabase.rpc("my_results"),
    supabase.from("review_requests").select("id, stage, message, status, response, created_at").order("created_at", { ascending: false }),
  ]);
  const reasoning = attempts?.[0];
  const parsed = MyResults.safeParse(results.data ?? []);
  if (results.error || !parsed.success) console.error("my_results", results.error ?? parsed.error);
  const applications = parsed.success ? parsed.data : [];
  const { error, sent } = await searchParams;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">My application</h1>
        <p className="muted">
          Where you are, what&apos;s next and every score so far. People on our team make every decision, and someone will
          get back to you at each step.
        </p>
      </div>

      {results.error || !parsed.success ? (
        <p className="error">We couldn&apos;t load your applications just now. Please refresh the page.</p>
      ) : applications.length ? (
        applications.map((a) => <ApplicationCard key={a.application_id} app={a} />)
      ) : (
        <section className="card">
          <h2 className="h2">Applications</h2>
          <p className="muted">
            {reasoning ? "No applications yet. " : null}
            <Link href={reasoning ? "/roles" : "/start"} className="underline">
              {reasoning ? "See open roles" : "Continue setting up your account"}
            </Link>
            .
          </p>
        </section>
      )}

      <details className="group card" open={!applications.length}>
        <summary className="flex cursor-pointer list-none items-center justify-between [&::-webkit-details-marker]:hidden">
          <h2 className="h2 mb-0">Reasoning Assessment</h2>
          <span className="flex items-center gap-3 text-sm text-slate-600">
            {reasoning ? `${"★".repeat(reasoning.stars)} · ${reasoning.raw_score} of 30` : "Not done yet"}
            <span className="transition-transform group-open:rotate-180" aria-hidden="true">▾</span>
          </span>
        </summary>
        <div className="mt-3">
          {reasoning ? (
            <ReasoningResultCard
              rawScore={reasoning.raw_score}
              percentile={Number(reasoning.percentile)}
              stars={reasoning.stars}
              normVersion={reasoning.norm_version}
            />
          ) : (
            <p className="notice">
              You haven&apos;t completed the Reasoning Assessment yet. <Link href="/start" className="underline">Continue</Link>
            </p>
          )}
        </div>
      </details>

      <details className="group card" open={!!error || !!sent}>
        <summary className="flex cursor-pointer list-none items-center justify-between [&::-webkit-details-marker]:hidden">
          <h2 className="h2 mb-0">Ask a person to review something</h2>
          <span className="flex items-center gap-3 text-sm text-slate-600">
            {reviews?.length ? `${reviews.length} request${reviews.length === 1 ? "" : "s"}` : null}
            <span className="transition-transform group-open:rotate-180" aria-hidden="true">▾</span>
          </span>
        </summary>
        <div className="mt-3 space-y-3">
          <p className="muted">
            You can ask a person on our team to review any score or decision, ask for an adjustment (for example typing
            your interview answers if you can&apos;t use a microphone), or tell us anything we should take into account. We
            will reply here.
          </p>
          <form action={requestReview} className="space-y-3">
            <select name="target" className="input" defaultValue="reasoning:" aria-label="What should we review?">
              {reviewTargets(applications).map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <textarea
              name="message"
              className="input"
              rows={4}
              minLength={10}
              maxLength={4000}
              required
              placeholder="What would you like us to review, and why?"
            />
            {error && <p className="error">{error}</p>}
            {sent && <p className="notice">Sent. We will reply here.</p>}
            <button className="btn">Send request</button>
          </form>
          {!!reviews?.length && (
            <ul className="space-y-2 text-sm">
              {reviews.map((r) => (
                <li key={r.id} className="rounded border border-slate-200 p-3">
                  <p className="muted">
                    {fmtDate(r.created_at)} · {REVIEW_STAGE_LABEL[r.stage] ?? r.stage} · {r.status}
                  </p>
                  <p>{r.message}</p>
                  {r.response && <p className="mt-1 border-l-2 border-slate-300 pl-2">Our reply: {r.response}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      <p className="muted">
        Optional: <Link href="/me/demographics" className="underline">help us check our assessments are fair</Link> (kept apart from
        your results and never used to assess you).
      </p>
    </div>
  );
}
