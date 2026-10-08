import Link from "next/link";
import { fmtDate, STAGE_LABEL, STATUS_LABEL } from "@/lib/format";
import { InterviewScore } from "./interview-score";
import { criterionLabel, DECISION_LABEL, fmtRubric } from "./labels";
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

function StatusNote({ app }: { app: ApplicationResult }) {
  if (app.status === "awaiting_review" && app.below_hurdle && app.stage === "interview") {
    return (
      <p className="notice">
        Your Reasoning Assessment result is below this role&apos;s usual level, so a person on our team will review your
        whole application (including your CV and experience) before the next stage opens. This is not a rejection.
      </p>
    );
  }
  if (app.status === "awaiting_review") {
    return (
      <p className="notice">
        What happens next: our team reviews your results before the next stage opens. No decision is automatic, and we
        will update this page.
      </p>
    );
  }
  if (app.status === "advanced" && !["interview", "quiz", "work_1", "work_2"].includes(app.stage)) {
    return <p className="notice">You have moved on to: {STAGE_LABEL[app.stage] ?? app.stage}. We will email you when it opens.</p>;
  }
  return null;
}

export function ApplicationCard({ app }: { app: ApplicationResult }) {
  const step = nextStep(app);
  return (
    <section className="card space-y-4" data-testid={`application-${app.role_slug}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="h2 mb-0">{app.role_title}</h2>
        <span className="muted">Applied {fmtDate(app.created_at)}</span>
      </div>
      <p className="text-sm">
        Stage: <strong>{STAGE_LABEL[app.stage] ?? app.stage}</strong> · Status:{" "}
        <strong>{STATUS_LABEL[app.status] ?? app.status}</strong>
      </p>
      <StatusNote app={app} />
      {step && (
        <Link href={step.href} className="btn">
          {step.label}
        </Link>
      )}

      {app.interview && (
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <h3 className="font-medium">AI CV interview</h3>
          <InterviewScore interview={app.interview} />
        </div>
      )}

      {app.quiz && (
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <h3 className="font-medium">Role quiz</h3>
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
        </div>
      )}

      {app.work.map((w) => (
        <div key={w.stage_key} className="space-y-2 border-t border-slate-100 pt-3" data-testid={`work-${w.stage_key}`}>
          <h3 className="font-medium">{w.title}</h3>
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
        </div>
      ))}

      {app.decisions.length > 0 && (
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <h3 className="font-medium">Decisions</h3>
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
        </div>
      )}
    </section>
  );
}
