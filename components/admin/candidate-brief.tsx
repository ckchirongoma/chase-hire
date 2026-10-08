"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { RECOMMENDATION_LABEL, type CandidateBrief } from "@/lib/briefs/schema";

type Stored = { content: CandidateBrief; model: string; promptVersion: string; createdAt: string; stale: boolean };

const TONE: Record<string, string> = {
  advance: "bg-emerald-50 border-emerald-300 text-emerald-900",
  hold: "bg-amber-50 border-amber-300 text-amber-900",
  do_not_advance: "bg-red-50 border-red-300 text-red-900",
  too_early: "bg-slate-50 border-slate-300 text-slate-800",
};

/**
 * The AI brief at the top of a candidate's admin page. Written automatically the first time the
 * page is opened and again when new results arrive. Internal and advisory: it never decides.
 */
export default function CandidateBriefCard({ userId, initial, initialError }: { userId: string; initial: Stored | null; initialError?: string | null }) {
  const [brief, setBrief] = useState<Stored | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const started = useRef(false);

  const write = useCallback(
    async (force: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/admin/candidates/${userId}/brief${force ? "?force=1" : ""}`, { method: "POST" });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Could not write the brief");
        setBrief(json as Stored);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not write the brief");
      } finally {
        setBusy(false);
      }
    },
    [userId],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!initial || initial.stale) void write(false);
  }, [initial, write]);

  const b = brief?.content;
  return (
    <section className="card space-y-4 border-slate-300" data-testid="candidate-brief">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="h2 mb-0">AI brief</h2>
        <span className="muted">
          Internal and advisory: you make every decision.
          {brief && <> · written {new Date(brief.createdAt).toLocaleString("en-ZA")}</>}
          {brief?.stale && !busy && <> · <span className="badge-warn">new results since</span></>}
        </span>
      </div>
      {busy && <p className="notice">{b ? "Updating the brief with the latest results…" : "Writing the brief from the CV, scores and grader notes…"}</p>}
      {error && <p className="error">Couldn&apos;t write the brief: {error}</p>}
      {b && (
        <>
          <div>
            <p className="font-medium">{b.headline}</p>
            <p className="mt-1 text-sm text-slate-700">{b.summary}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-emerald-800">Strengths</h3>
              <ul className="mt-1 space-y-1.5 text-sm">
                {b.strengths.map((s, i) => (
                  <li key={i}>
                    {s.point} {s.evidence && <span className="muted">({s.evidence})</span>}
                  </li>
                ))}
                {!b.strengths.length && <li className="muted">None identified yet.</li>}
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-amber-800">Concerns</h3>
              <ul className="mt-1 space-y-1.5 text-sm">
                {b.concerns.map((s, i) => (
                  <li key={i}>
                    {s.point} {s.evidence && <span className="muted">({s.evidence})</span>}
                  </li>
                ))}
                {!b.concerns.length && <li className="muted">None identified.</li>}
              </ul>
            </div>
          </div>
          {b.recommendations.map((r, i) => (
            <div key={i} className={`rounded-lg border p-3 text-sm ${TONE[r.recommendation]}`} data-testid="brief-recommendation">
              <p className="font-semibold">
                {r.role}: {RECOMMENDATION_LABEL[r.recommendation]} <span className="font-normal">({r.confidence} confidence)</span>
              </p>
              <p className="mt-1">{r.reasoning}</p>
              {r.check_next && <p className="mt-1"><strong>Check next:</strong> {r.check_next}</p>}
            </div>
          ))}
          {!!b.live_questions.length && (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">Questions for a live session</summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                {b.live_questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ol>
            </details>
          )}
          <p className="muted">
            Written by {brief!.model} ({brief!.promptVersion}) from the parsed CV, scores, grader feedback, flags and decisions, without the
            candidate&apos;s name or contact details. It can be wrong: check the evidence below before you decide.{" "}
            <button type="button" className="underline" disabled={busy} onClick={() => void write(true)}>
              Rewrite it
            </button>
          </p>
        </>
      )}
    </section>
  );
}
