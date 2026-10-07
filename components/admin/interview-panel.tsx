import { createClient } from "@/lib/supabase/server";
import { fmtDate } from "@/lib/format";

/**
 * Admin view of one application's AI CV-verification interview: transcript, per-criterion
 * scores with every sample's evidence and rationale, review flags, verification concerns and
 * suggested live follow-ups. Uses the admin's own client (admins have SELECT under RLS).
 * Scores are advisory: they sort and flag, a person decides.
 */

type Evidence = { quote: string; location?: string };
type Sample = {
  criterion_key: string;
  sample_idx: number;
  score: number;
  evidence: Evidence[];
  rationale: string;
  extra: { feedback?: string; invalid?: boolean; rerun?: boolean; unverified_quote?: boolean; unverified_quotes?: string[]; injection_in_quotes?: boolean };
  model: string;
  prompt_version: string;
  temperature: number;
};
type SummaryRow = {
  criterion_key: string;
  weight: number;
  median_score: number | null;
  spread: number | null;
  needs_human_review: boolean;
  review_reason: string | null;
  human_score: number | null;
  human_reason: string | null;
  final_score: number | null;
  feedback: string | null;
};
type Criterion = { key: string; title: string };
type Message = { id: string; role: string; content: string; step: string | null; claim_id: string | null; meta: Record<string, unknown> | null; created_at: string };
type SessionSummary = {
  verification_concerns?: { claim: string; reason: string }[];
  live_followups?: string[];
  concerns_model?: string | null;
  concerns_prompt_version?: string | null;
  concerns_error?: string | null;
  no_answers?: boolean;
  transcript_flags?: string[];
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export default async function InterviewPanel({ applicationId }: { applicationId: string }) {
  const supabase = await createClient();
  const { data: session } = await supabase
    .from("interview_sessions")
    .select("id, plan, started_at, deadline_at, ended_at, end_reason, summary, score, model, prompt_version")
    .eq("application_id", applicationId)
    .maybeSingle();

  if (!session) {
    return (
      <section className="card">
        <h2 className="h2">AI CV interview</h2>
        <p className="muted">Not started.</p>
      </section>
    );
  }

  const [messages, summaries, samples, rubric, job] = await Promise.all([
    supabase.from("interview_messages").select("id, role, content, step, claim_id, meta, created_at").eq("session_id", session.id).order("created_at"),
    supabase.from("grade_summaries").select("criterion_key, weight, median_score, spread, needs_human_review, review_reason, human_score, human_reason, final_score, feedback").eq("subject_type", "interview").eq("subject_id", session.id),
    supabase.from("grades").select("criterion_key, sample_idx, score, evidence, rationale, extra, model, prompt_version, temperature").eq("subject_type", "interview").eq("subject_id", session.id).order("sample_idx"),
    supabase.from("rubrics").select("criteria").eq("key", "interview").eq("version", 1).maybeSingle(),
    supabase.from("grading_jobs").select("status, attempts, last_error, updated_at").eq("subject_type", "interview").eq("subject_id", session.id).maybeSingle(),
  ]);

  const msgs = [...((messages.data ?? []) as Message[])].sort((a, b) => {
    const ai = typeof a.meta?.idx === "number" ? a.meta.idx : Infinity;
    const bi = typeof b.meta?.idx === "number" ? b.meta.idx : Infinity;
    return ai !== bi ? ai - bi : a.created_at.localeCompare(b.created_at);
  });
  const criteria = (rubric.data?.criteria ?? []) as Criterion[];
  const byKey = new Map(((summaries.data ?? []) as SummaryRow[]).map((s) => [s.criterion_key, s]));
  const samplesByKey = new Map<string, Sample[]>();
  for (const s of (samples.data ?? []) as Sample[]) samplesByKey.set(s.criterion_key, [...(samplesByKey.get(s.criterion_key) ?? []), s]);
  const summary = (session.summary ?? {}) as SessionSummary;
  const plan = session.plan as { claims?: { id: string; text: string; why: string }[]; selection?: { via: string; model: string | null } };
  const flagged = [...byKey.values()].filter((s) => s.needs_human_review && s.human_score === null).length;
  const sampleMeta = (samples.data as Sample[] | null)?.[0];

  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="h2">AI CV interview</h2>
        <p className="text-sm">
          {session.score !== null ? <strong>{Number(session.score).toFixed(1)}/100</strong> : <span className="muted">not scored</span>}{" "}
          {flagged > 0 && <span className="badge-warn">{flagged} criteria need human review</span>}
        </p>
      </div>
      <p className="muted">
        Started {fmtDate(session.started_at)} · {session.ended_at ? `ended ${fmtDate(session.ended_at)} (${session.end_reason})` : `deadline ${fmtDate(session.deadline_at)}`}
        {" · "}grading: {job.data ? `${job.data.status} (attempts ${job.data.attempts})` : "not queued"}
        {job.data?.last_error && <span className="badge-bad ml-1">{job.data.last_error.slice(0, 120)}</span>}
      </p>
      <p className="muted">
        Model {session.model ?? sampleMeta?.model ?? "—"} · prompt {session.prompt_version ?? sampleMeta?.prompt_version ?? "—"}
        {sampleMeta && <> · T={sampleMeta.temperature} · 3 samples, median</>}
        {summary.concerns_prompt_version && <> · concerns {summary.concerns_prompt_version}</>}
        {plan.selection && <> · claim selection via {plan.selection.via}{plan.selection.model ? ` (${plan.selection.model})` : ""}</>}
      </p>
      {summary.no_answers && <p className="notice">The candidate gave no answers before the interview ended.</p>}
      {!!summary.transcript_flags?.length && <p className="badge-bad">Sanitiser flags in answers: {summary.transcript_flags.join(", ")}</p>}

      {!!plan.claims?.length && (
        <div className="text-sm">
          <p className="font-medium">Claims probed</p>
          <ul className="list-disc pl-5">
            {plan.claims.map((c) => (
              <li key={c.id}>
                <span className="badge">{c.id}</span> {c.text} <span className="muted">({c.why.replace(/_/g, " ")})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <p className="font-medium">Scores by criterion (advisory)</p>
        <table className="table">
          <thead>
            <tr><th>Criterion</th><th>Median</th><th>Spread</th><th>Final</th><th>Flags</th><th>Samples: evidence and rationale</th></tr>
          </thead>
          <tbody>
            {(criteria.length ? criteria : [...byKey.keys()].map((k) => ({ key: k, title: k }))).map((c) => {
              const s = byKey.get(c.key);
              const rows = samplesByKey.get(c.key) ?? [];
              return (
                <tr key={c.key}>
                  <td className="font-medium">{c.title}</td>
                  <td>{num(s?.median_score) ?? "—"}</td>
                  <td>{num(s?.spread) ?? "—"}</td>
                  <td>
                    {num(s?.final_score) ?? "—"}
                    {s?.human_score != null && <span className="badge ml-1">human: {num(s.human_score)}</span>}
                  </td>
                  <td>
                    {s?.needs_human_review && s.human_score == null && <span className="badge-warn">needs review</span>}
                    {s?.human_score != null && <span className="badge">resolved by a person</span>}
                    {s?.review_reason && <p className="muted">{s.review_reason}</p>}
                    {s?.human_reason && <p className="muted">Human: {s.human_reason}</p>}
                  </td>
                  <td>
                    <details>
                      <summary className="cursor-pointer underline">{rows.map((r) => r.score).join(" · ") || "no samples"}</summary>
                      <div className="mt-2 space-y-3">
                        {rows.map((r) => (
                          <div key={r.sample_idx} className="rounded border border-slate-200 p-2">
                            <p className="text-xs">
                              Sample {r.sample_idx + 1}: <strong>{r.score}</strong> · {r.model}
                              {r.extra?.invalid && <span className="badge-bad ml-1">no evidence (excluded)</span>}
                              {r.extra?.rerun && <span className="badge ml-1">re-run</span>}
                              {r.extra?.unverified_quote && <span className="badge-warn ml-1">quote not found</span>}
                              {r.extra?.injection_in_quotes && <span className="badge-bad ml-1">injection-like quote</span>}
                            </p>
                            <ul className="mt-1 list-disc pl-5 text-xs">
                              {(r.evidence ?? []).map((e, i) => (
                                <li key={i}>
                                  &ldquo;{e.quote}&rdquo; <span className="muted">{e.location}</span>
                                </li>
                              ))}
                            </ul>
                            <p className="mt-1 text-xs text-slate-700">{r.rationale}</p>
                            {r.extra?.feedback && <p className="muted text-xs">Candidate feedback: {r.extra.feedback}</p>}
                          </div>
                        ))}
                      </div>
                    </details>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="text-sm">
          <p className="font-medium">Verification concerns</p>
          {summary.concerns_error && <p className="badge-bad">Concerns call failed: {summary.concerns_error.slice(0, 160)}</p>}
          {summary.verification_concerns?.length ? (
            <ul className="list-disc pl-5">
              {summary.verification_concerns.map((v, i) => (
                <li key={i}>
                  <strong>{v.claim}</strong>: {v.reason}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{session.summary ? "None raised." : "Not graded yet."}</p>
          )}
        </div>
        <div className="text-sm">
          <p className="font-medium">Suggested live-interview follow-ups</p>
          {summary.live_followups?.length ? (
            <ol className="list-decimal pl-5">
              {summary.live_followups.map((q, i) => <li key={i}>{q}</li>)}
            </ol>
          ) : (
            <p className="muted">{session.summary ? "None." : "Not graded yet."}</p>
          )}
        </div>
      </div>

      <details>
        <summary className="cursor-pointer text-sm underline">Transcript ({msgs.length} messages)</summary>
        <div className="mt-2 space-y-2">
          {msgs.map((m, i) => {
            const jev = (m.meta?.jev ?? null) as { off_script?: number; role_question?: number; probe_needed?: number | null; model?: string } | null;
            return (
              <div key={m.id} className={`rounded p-2 text-sm ${m.role === "candidate" ? "bg-slate-50" : ""}`}>
                <p className="text-xs text-slate-500">
                  #{i} {m.role} {m.step && <span className="badge">{m.step}</span>} {m.claim_id && <span className="badge">{m.claim_id}</span>} {fmtDate(m.created_at)}
                  {m.role === "candidate" && m.meta && (
                    <span className="ml-1">
                      · decision {String(m.meta.decision ?? "—")} via {String(m.meta.via ?? "—")}
                      {jev && <> (JEV {jev.model}: probe {jev.probe_needed ?? "—"}, off-script {jev.off_script}, role-q {jev.role_question})</>}
                      {m.meta.regex_injection === true && <span className="badge-bad ml-1">injection pattern</span>}
                      {m.meta.off_script_via === "jev" && <span className="badge ml-1">off-script (JEV only, not an injection signal)</span>}
                      {m.meta.jev_timeout === true && <span className="badge ml-1">JEV timed out</span>}
                      {m.meta.decision === undefined && <span className="badge-warn ml-1">not yet processed</span>}
                    </span>
                  )}
                </p>
                <p className="whitespace-pre-line">{m.content}</p>
              </div>
            );
          })}
        </div>
      </details>
    </section>
  );
}
