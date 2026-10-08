import Link from "next/link";
import { fmtDate, STAGE_LABEL, STATUS_LABEL } from "@/lib/format";
import { InterviewScore } from "./interview-score";
import { criterionLabel, DECISION_LABEL, fmtRubric } from "./labels";
import { JourneyDiagram } from "./journey-diagram";
import { journey, stepDuration } from "./journey";
import { nextStep } from "./next-step";
import { QuizScore } from "./quiz-score";
import type { ApplicationResult } from "./schema";

function WorkCriteria({ criteria }: { criteria: ApplicationResult["work"][number]["criteria"] }) {
  if (!criteria.length) return null;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>What we looked at</th>
          <th>Score</th>
          <th>Feedback</th>
        </tr>
      </thead>
      <tbody>
        {criteria.map((c) => (
          <tr key={c.key}>
            <td>{criterionLabel(c.key)}</td>
            <td className="whitespace-nowrap">
              {c.under_review ? <span className="badge-warn">Under review</span> : c.final_score != null ? fmtRubric(c.final_score) : "—"}
            </td>
            <td>{c.feedback ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** What happens now, in plain words: the next step (with a break first if they like), or who is on it. */
function WhatNow({ app }: { app: ApplicationResult }) {
  const step = nextStep(app);
  const closed = ["rejected", "withdrawn", "lapsed"].includes(app.status) || app.stage === "closed";
  let title: string;
  let body: React.ReactNode;
  if (closed) {
    title = "This application has closed";
    body = (
      <>
        Thank you for the time you put in. Our reason is under &quot;Decisions&quot; below, and you can ask a person to review
        it.
      </>
    );
  } else if (step) {
    title = `Your next step: ${step.label.replace(/^(Start|Open|Continue) the |^(Start|Open|Continue) /, "")}`;
    body = (
      <>
        {stepDuration(app.role_slug, app.stage)} Nothing starts until you press Start on the next page, so take a break
        first if you need one.
      </>
    );
  } else if (app.status === "awaiting_review" && app.below_hurdle && app.stage === "interview") {
    title = "A person is reviewing your application";
    body = (
      <>
        Your Reasoning Assessment result is below this role&apos;s usual level, so someone on our team will look at your whole
        application, including your CV and experience, before the next stage opens. This is not a rejection. We&apos;ll get
        back to you by email and update this page.
      </>
    );
  } else if (app.stage === "shortlist" || app.stage === "live") {
    title = "You're through to a live session with our team";
    body = <>Someone from our team will get back to you by email to book a time. There&apos;s nothing you need to do until then.</>;
  } else if (app.stage === "offer") {
    title = "We'll be in touch";
    body = <>Someone from our team will get back to you by email about the next step.</>;
  } else {
    title = "Over to us";
    body = (
      <>
        You&apos;ve done everything for now. Our team is reviewing your results; nothing is decided automatically. Someone
        will get back to you by email, and this page will update when the next stage opens.
      </>
    );
  }
  return (
    <div className={`rounded-lg border p-4 ${step ? "border-slate-900 bg-slate-50" : "border-amber-200 bg-amber-50"}`} data-testid="what-now">
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-sm text-slate-700">{body}</p>
      {step && (
        <Link href={step.href} className="btn mt-3">
          {step.label}
        </Link>
      )}
    </div>
  );
}

/** A collapsible results section. */
function Section({ title, summary, open, children, testId }: { title: string; summary?: React.ReactNode; open?: boolean; children: React.ReactNode; testId?: string }) {
  return (
    <details className="group rounded-lg border border-slate-200" open={open} data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <h3 className="font-medium">{title}</h3>
        <span className="flex items-center gap-3 text-sm text-slate-600">
          {summary}
          <span className="transition-transform group-open:rotate-180" aria-hidden="true">▾</span>
        </span>
      </summary>
      <div className="space-y-2 border-t border-slate-100 px-4 py-3">{children}</div>
    </details>
  );
}

export function ApplicationCard({ app }: { app: ApplicationResult }) {
  const sections = journey(app);
  const finished = [
    app.interview?.ended_at ? "interview" : null,
    app.quiz?.submitted_at ? "quiz" : null,
    ...app.work.filter((w) => w.submitted_at).map((w) => w.stage_key),
  ].filter(Boolean);
  const latest = finished.at(-1);
  return (
    <section className="card space-y-5" data-testid={`application-${app.role_slug}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="h2 mb-0">{app.role_title}</h2>
        <span className="muted">
          Applied {fmtDate(app.created_at)} · {STATUS_LABEL[app.status] ?? app.status}
        </span>
      </div>

      <JourneyDiagram sections={sections} />
      <WhatNow app={app} />

      <div className="space-y-2">
        {app.interview && (
          <Section
            title="AI CV interview"
            open={latest === "interview"}
            summary={app.interview.ended_at ? (app.interview.score != null ? `${Math.round(app.interview.score)} / 100` : "Being scored") : "In progress"}
          >
            <InterviewScore interview={app.interview} />
          </Section>
        )}

        {app.quiz && (
          <Section
            title="Role quiz"
            open={latest === "quiz"}
            summary={app.quiz.submitted_at && app.quiz.pct != null ? `${Math.round(app.quiz.pct)}%` : "In progress"}
          >
            {app.quiz.submitted_at && app.quiz.pct != null ? (
              <QuizScore
                rawScore={app.quiz.raw_score ?? 0}
                total={Object.values(app.quiz.topic_scores ?? {}).reduce((n, t) => n + t.total, 0) || 15}
                pct={app.quiz.pct}
                topicScores={app.quiz.topic_scores ?? {}}
                roleSlug={app.role_slug}
              />
            ) : (
              <p className="text-sm">In progress. The clock keeps running on our server.</p>
            )}
          </Section>
        )}

        {app.work.map((w) => (
          <Section
            key={w.stage_key}
            title={w.title}
            testId={`work-${w.stage_key}`}
            open={latest === w.stage_key}
            summary={
              !w.submitted_at
                ? w.started_at
                  ? "In progress"
                  : "Not started"
                : w.score != null && w.grading_status === "done"
                  ? `${Math.round(w.score)} / 100`
                  : "Being scored"
            }
          >
            {!w.submitted_at ? (
              <p className="text-sm">
                {w.started_at ? `In progress. Due ${fmtDate(w.deadline_at)}.` : `Open until ${fmtDate(w.open_until)}. The clock starts when you press Start.`}
              </p>
            ) : w.score != null && w.grading_status === "done" ? (
              <>
                <p className="text-sm" data-testid={`work-score-${w.stage_key}`}>
                  Score: <strong>{Math.round(w.score)} / 100</strong> (advisory; our team reviews every submission)
                </p>
                <WorkCriteria criteria={w.criteria} />
              </>
            ) : w.grading_status === "needs_review" ? (
              <>
                <p className="text-sm"><span className="badge-warn">Parts of this are being reviewed by a person</span></p>
                <WorkCriteria criteria={w.criteria} />
              </>
            ) : (
              <p className="text-sm">Submitted {fmtDate(w.submitted_at)}. Being scored; check back later.</p>
            )}
          </Section>
        ))}

        {app.decisions.length > 0 && (
          <Section title="Decisions" open summary={`${app.decisions.length}`}>
            <ul className="space-y-2 text-sm">
              {app.decisions.map((d) => (
                <li key={d.decided_at + d.decision}>
                  <p className="muted">
                    {fmtDate(d.decided_at)} · {STAGE_LABEL[d.stage] ?? d.stage} · {DECISION_LABEL[d.decision] ?? d.decision}
                  </p>
                  <p>Our reason: {d.reason}</p>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </section>
  );
}
