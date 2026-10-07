import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { finaliseExpiredQuizzes } from "@/lib/server/quiz";
import { QUIZ_GRACE_MS } from "@/lib/quiz/blueprint";
import { fmtDate } from "@/lib/format";
import { topicLabel, topicsFor } from "@/lib/quiz/blueprint";
import { answerTimeFlag } from "@/lib/quiz/signals";
import type { TopicScores } from "@/lib/quiz/scoring";

// Admin-only view of one application's role quiz. Reads with the signed-in user's session,
// so RLS (admin-only SELECT on quiz tables) protects it even if embedded by mistake.

type Rendered = { stem: string; options: string[]; multi: boolean };
type ResponseRow = {
  position: number;
  topic: string;
  rendered: Rendered;
  answer_key: number[];
  served_at: string | null;
  answered_at: string | null;
  answer: number[] | null;
  correct: boolean | null;
};

const LETTERS = "ABCDE";
const letters = (idx: number[] | null) => (idx?.length ? idx.map((i) => LETTERS[i] ?? "?").join(", ") : "—");

function seconds(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 100) / 10;
}

const ATTEMPT_SELECT =
  "id, started_at, deadline_at, submitted_at, raw_score, pct, topic_scores, below_flag, item_count, applications(roles(slug, quiz_flag_pct))";

export async function QuizPanel({ applicationId }: { applicationId: string }) {
  const supabase = await createClient();
  const read = () => supabase.from("quiz_attempts").select(ATTEMPT_SELECT).eq("application_id", applicationId).maybeSingle();
  let { data: attempt } = await read();

  // An abandoned attempt past its deadline is finalised here too (as well as by the cron
  // sweep), so the admin sees the score. The row was readable through RLS, so the viewer
  // is an admin; the service role is used only for this one application.
  if (attempt && !attempt.submitted_at && Date.now() > new Date(attempt.deadline_at).getTime() + QUIZ_GRACE_MS) {
    await finaliseExpiredQuizzes(createAdminClient(), { applicationId });
    ({ data: attempt } = await read());
  }

  if (!attempt) {
    return (
      <section className="card">
        <h2 className="h2">Role quiz</h2>
        <p className="muted">Not started.</p>
      </section>
    );
  }

  const role = (attempt.applications as unknown as { roles: { slug: string; quiz_flag_pct: number } } | null)?.roles;
  const { data } = await supabase
    .from("quiz_responses")
    .select("position, topic, rendered, answer_key, served_at, answered_at, answer, correct")
    .eq("attempt_id", attempt.id)
    .order("position");
  const rows = (data ?? []) as ResponseRow[];
  const topicScores = (attempt.topic_scores ?? {}) as TopicScores;
  const order = topicsFor(role?.slug ?? "");
  const topics = [...order.filter((t) => topicScores[t]), ...Object.keys(topicScores).filter((t) => !order.includes(t))];
  const used = seconds(attempt.started_at, attempt.submitted_at);

  return (
    <section className="card space-y-4" data-testid="quiz-panel">
      <h2 className="h2">Role quiz</h2>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span>Started {fmtDate(attempt.started_at)}</span>
        <span>Deadline {fmtDate(attempt.deadline_at)}</span>
        <span>{attempt.submitted_at ? `Submitted ${fmtDate(attempt.submitted_at)}` : "Not submitted"}</span>
        {used != null && <span>Time used {Math.floor(used / 60)}m {Math.round(used % 60)}s</span>}
      </div>

      {attempt.submitted_at && (
        <p className="text-sm">
          Score <strong>{attempt.raw_score} / {attempt.item_count}</strong> ({Math.round(Number(attempt.pct))}%){" "}
          {attempt.below_flag ? (
            <span className="badge-warn">Below the flag line ({role?.quiz_flag_pct ?? "?"}%) — review, never auto-reject</span>
          ) : (
            <span className="badge">At or above the flag line ({role?.quiz_flag_pct ?? "?"}%)</span>
          )}
        </p>
      )}

      {topics.length > 0 && (
        <table className="table w-auto">
          <thead>
            <tr><th>Topic</th><th>Correct</th></tr>
          </thead>
          <tbody>
            {topics.map((t) => (
              <tr key={t}>
                <td>{topicLabel(t)}</td>
                <td>{topicScores[t]!.correct} / {topicScores[t]!.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <table className="table">
        <thead>
          <tr><th>#</th><th>Topic</th><th>Question</th><th>Time</th><th>Answer</th><th>Key</th><th>Result</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const secs = seconds(r.served_at, r.answered_at);
            const flag = secs != null && r.correct ? answerTimeFlag({ multi: r.rendered.multi, correct: true, ms: secs * 1000 }) : null;
            return (
              <tr key={r.position}>
                <td>{r.position}</td>
                <td className="whitespace-nowrap">{topicLabel(r.topic)}</td>
                <td>
                  <details>
                    <summary className="cursor-pointer">
                      {r.rendered.stem.length > 90 ? `${r.rendered.stem.slice(0, 90)}…` : r.rendered.stem}
                      {r.rendered.multi && <span className="badge ml-1">select all</span>}
                    </summary>
                    <p className="mt-1">{r.rendered.stem}</p>
                    <ol className="mt-1 space-y-0.5">
                      {r.rendered.options.map((o, i) => (
                        <li key={i} className={r.answer_key.includes(i) ? "font-medium text-green-700" : ""}>
                          {LETTERS[i]}. {o}
                          {r.answer?.includes(i) ? " ← chosen" : ""}
                        </li>
                      ))}
                    </ol>
                  </details>
                </td>
                <td className="whitespace-nowrap">
                  {!r.served_at ? "not reached" : secs != null ? `${secs}s` : "—"}
                  {flag && <span className="badge-warn ml-1">{flag === "fast_correct" ? "fast" : "long stall"}</span>}
                </td>
                <td>{r.answered_at ? letters(r.answer) : "—"}</td>
                <td>{letters(r.answer_key)}</td>
                <td>
                  {r.correct ? (
                    <span className="badge">correct</span>
                  ) : r.answered_at && r.answer ? (
                    <span className="badge-bad">wrong</span>
                  ) : r.answered_at ? (
                    <span className="badge">skipped</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted">
        Timing flags are signals for discussion only. They never count as evidence on their own.
      </p>
    </section>
  );
}
