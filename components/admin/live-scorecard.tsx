import { fmtDate } from "@/lib/format";
import { KIND_LABEL, parseNotes, SCORE_VALUES, type LiveQuestion, type ScoredKind } from "@/lib/live/scorecard";
import type { KindCount, Scorecard } from "@/lib/server/live";
import { saveScorecard } from "@/app/admin/live/actions";
import LiveSubmitButton from "./live-submit-button";

/**
 * One live scorecard (docs/09 §5) for the signed-in panellist: every question with its standard
 * probes and 1/3/5 behavioural anchors, a 1–5 score and a note each. Drafts are private; a
 * submitted card is final (DB guard). Other panellists' cards appear only after this panellist
 * has submitted theirs (RLS), so everyone scores independently before any discussion.
 */

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : null);

function Anchors({ q }: { q: LiveQuestion }) {
  return (
    <table className="table text-xs">
      <tbody>
        {(["1", "3", "5"] as const).map((level) => (
          <tr key={level}>
            <td className="w-8 font-medium">{level}</td>
            <td>{q.anchors[level] || <span className="muted">(no anchor)</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function QuestionHead({ q, n }: { q: LiveQuestion; n: number }) {
  return (
    <div className="space-y-1">
      <p className="font-medium">
        {n}. {q.text}{" "}
        {q.source === "concern" ? <span className="badge-warn">from the AI-interview verification concerns</span> : null}
      </p>
      {q.probes.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs underline">Standard probes ({q.probes.length})</summary>
          <ul className="ml-5 list-disc text-xs text-slate-700">
            {q.probes.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </details>
      )}
      <Anchors q={q} />
    </div>
  );
}

function ReadOnlyCard({ card, questions, label }: { card: Scorecard; questions: LiveQuestion[]; label: string }) {
  const notes = parseNotes(card.notes, questions.map((q) => q.key));
  return (
    <div className="space-y-2 rounded-md border border-slate-200 p-3 text-sm" data-testid="live-card-readonly">
      <p>
        <strong>{label}</strong> · total <strong>{card.total ?? "—"}</strong>/100 · submitted {fmtDate(card.submitted_at)}
      </p>
      <table className="table text-xs">
        <tbody>
          {questions.map((q, i) => (
            <tr key={q.key}>
              <td className="w-8">{i + 1}</td>
              <td>{q.text.length > 90 ? `${q.text.slice(0, 90)}…` : q.text}</td>
              <td className="w-10 font-medium">{num(card.scores[q.key]) ?? "—"}</td>
              <td className="text-slate-600">{notes.perQuestion[q.key] ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {notes.general && <p className="whitespace-pre-line text-xs text-slate-700">{notes.general}</p>}
    </div>
  );
}

export default function LiveScorecard({
  applicationId,
  kind,
  weight,
  questions,
  mine,
  others,
  names,
  count,
  disabled,
}: {
  applicationId: string;
  kind: ScoredKind;
  /** Share of the live stage (docs/09 §2), e.g. 40. */
  weight: number;
  questions: LiveQuestion[];
  mine: Scorecard | null;
  /** Other panellists' cards this viewer may see (only after submitting their own). */
  others: Scorecard[];
  names: Map<string, string>;
  count: KindCount | undefined;
  /** The application has left the shortlist/live stage. */
  disabled: boolean;
}) {
  const submitted = Boolean(mine?.submitted_at);
  const othersSubmitted = (count?.submitted ?? 0) - (submitted ? 1 : 0);
  const draftNotes = parseNotes(mine?.notes ?? null, questions.map((q) => q.key));

  return (
    <section id={kind} className="card space-y-4" data-testid={`live-card-${kind}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="h2">
          {KIND_LABEL[kind]} <span className="muted">· {weight}% of the live stage</span>
        </h2>
        <p className="text-sm">
          {count?.submitted ?? 0} panellist{count?.submitted === 1 ? "" : "s"} submitted
          {submitted ? <span className="badge ml-1">you submitted</span> : mine ? <span className="badge-warn ml-1">your draft</span> : null}
        </p>
      </div>

      {!questions.length && <p className="error">No active questions in the bank for this part.</p>}

      {submitted && mine ? (
        <>
          <ReadOnlyCard card={mine} questions={questions} label="Your scorecard (final)" />
          <div className="space-y-2">
            <h3 className="font-medium">Other panellists</h3>
            {others.length ? (
              others.map((c) => <ReadOnlyCard key={c.id} card={c} questions={questions} label={names.get(c.rater) ?? "Panellist"} />)
            ) : (
              <p className="muted">No other panellist has submitted this part yet.</p>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="notice" data-testid="independence-note">
            Score on your own, before any discussion. Other panellists&apos; scores for this part are hidden until you submit yours
            {othersSubmitted > 0 ? ` (${othersSubmitted} already submitted)` : ""}. Submitting is final.
          </p>
          {questions.length > 0 && (
            <form action={saveScorecard} className="space-y-5">
              <input type="hidden" name="application_id" value={applicationId} />
              <input type="hidden" name="kind" value={kind} />
              {questions.map((q, i) => {
                const current = num(mine?.scores[q.key]);
                return (
                  <fieldset key={q.key} className="space-y-2 border-t border-slate-100 pt-3" disabled={disabled}>
                    <QuestionHead q={q} n={i + 1} />
                    <div className="flex flex-wrap items-center gap-3 text-sm" role="radiogroup" aria-label={`Score for question ${i + 1}`}>
                      <span className="text-slate-600">Score:</span>
                      {SCORE_VALUES.map((v) => (
                        <label key={v} className="inline-flex items-center gap-1">
                          <input type="radio" name={`score:${q.key}`} value={v} defaultChecked={current === v} /> {v}
                        </label>
                      ))}
                    </div>
                    <textarea
                      name={`note:${q.key}`}
                      rows={2}
                      maxLength={4000}
                      className="input"
                      placeholder="Evidence: what they said that fits the anchor"
                      defaultValue={draftNotes.perQuestion[q.key] ?? ""}
                    />
                  </fieldset>
                );
              })}
              <fieldset className="space-y-2" disabled={disabled}>
                <label className="label" htmlFor={`notes-${kind}`}>
                  General notes
                </label>
                <textarea id={`notes-${kind}`} name="notes" rows={3} maxLength={8000} className="input" defaultValue={draftNotes.general} />
                <div className="flex flex-wrap gap-2">
                  <button type="submit" name="intent" value="draft" className="btn-secondary">
                    Save draft
                  </button>
                  <LiveSubmitButton message="Submit this scorecard? It is final and can't be edited. You will then see the other panellists' scores for this part." />
                </div>
                {disabled && <p className="muted">This application has left the live stage; scorecards are closed.</p>}
              </fieldset>
            </form>
          )}
        </>
      )}
    </section>
  );
}
