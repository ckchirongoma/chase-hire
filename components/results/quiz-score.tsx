import { topicLabel, topicsFor } from "@/lib/quiz/blueprint";
import type { TopicScores } from "@/lib/quiz/scoring";
import { fmtPct } from "./labels";

// No hooks and no server-only imports: rendered by the results page (server) and by the
// quiz runner's done screen (client).

export function TopicBreakdown({ topicScores, roleSlug }: { topicScores: TopicScores; roleSlug: string }) {
  const order = topicsFor(roleSlug);
  const keys = [
    ...order.filter((t) => topicScores[t]),
    ...Object.keys(topicScores).filter((t) => !order.includes(t)),
  ];
  if (!keys.length) return null;
  return (
    <table className="table" data-testid="quiz-topics">
      <thead>
        <tr>
          <th>Topic</th>
          <th>Correct</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((t) => {
          const s = topicScores[t]!;
          return (
            <tr key={t}>
              <td>{topicLabel(t)}</td>
              <td>
                {s.correct} of {s.total}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function QuizScore({
  rawScore,
  total,
  pct,
  topicScores,
  roleSlug,
}: {
  rawScore: number;
  total: number;
  pct: number;
  topicScores: TopicScores;
  roleSlug: string;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm" data-testid="quiz-score">
        You answered <strong>{rawScore} of {total}</strong> questions correctly: <strong>{fmtPct(pct)}</strong>.
      </p>
      <TopicBreakdown topicScores={topicScores} roleSlug={roleSlug} />
      <p className="muted">
        The role quiz checks job knowledge. Skipped questions, and &quot;select all that apply&quot; questions without
        every correct option, count as not correct. Our team sees this score alongside the rest of your application;
        it is never used to reject anyone automatically.
      </p>
    </div>
  );
}
