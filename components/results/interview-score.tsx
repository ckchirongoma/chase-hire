import { criterionLabel, fmtRubric } from "./labels";
import type { InterviewResult } from "./schema";

export function InterviewScore({ interview }: { interview: InterviewResult }) {
  if (!interview.ended_at) {
    return <p className="text-sm">In progress. Your answers are saved as you go.</p>;
  }
  const anyUnderReview = interview.criteria.some((c) => c.under_review);
  return (
    <div className="space-y-2">
      {interview.end_reason === "timeout" && <p className="muted">The interview ended when the time ran out.</p>}
      {interview.score != null ? (
        <p className="text-sm" data-testid="interview-score">
          Interview score: <strong>{Math.round(interview.score)} / 100</strong>
        </p>
      ) : (
        <p className="text-sm">
          {anyUnderReview ? (
            <span className="badge-warn">Under review by our team</span>
          ) : (
            "Being scored. Check back later."
          )}
        </p>
      )}
      {interview.criteria.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>What we looked at</th>
              <th>Score</th>
              <th>Feedback</th>
            </tr>
          </thead>
          <tbody>
            {interview.criteria.map((c) => (
              <tr key={c.key}>
                <td>{criterionLabel(c.key)}</td>
                <td className="whitespace-nowrap">
                  {c.under_review ? (
                    <span className="badge-warn">Under review</span>
                  ) : c.final_score != null ? (
                    fmtRubric(c.final_score)
                  ) : (
                    "—"
                  )}
                </td>
                <td>{c.feedback ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {interview.score != null && (
        <p className="muted">
          Each area is scored from 1 to 5. A person on our team checks any score where the automated graders disagreed,
          and no decision is made on the interview score alone.
        </p>
      )}
    </div>
  );
}
