import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/server/auth";
import { fmtDate, STAGE_LABEL, STATUS_LABEL } from "@/lib/format";
import InterviewPanel from "@/components/admin/interview-panel";
import { QuizPanel } from "@/components/admin/quiz-panel";
import WorkPanel from "@/components/admin/work-panel";
import WorkGrades from "@/components/admin/work-grades";
import SessionControls from "@/components/admin/session-controls";
import CandidateBriefCard from "@/components/admin/candidate-brief";
import { getBrief, type StoredBrief } from "@/lib/server/brief";
import { computeScores, refreshQuietly, refreshScores } from "@/lib/server/scores";
import { viewerLiveGate } from "@/lib/server/live";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const Decision = z.object({
  user_id: z.uuid(),
  application_id: z.uuid(),
  decision: z.enum(["advance", "reject", "hold"]),
  reason: z.string().trim().min(20, "Reason must be at least 20 characters and reference the criteria."),
});

async function decide(formData: FormData) {
  "use server";
  const { supabase } = await requireAdmin();
  const parsed = Decision.safeParse(Object.fromEntries(formData));
  const uid = String(formData.get("user_id"));
  if (!parsed.success) redirect(`/admin/candidates/${uid}?error=${encodeURIComponent(parsed.error.issues[0].message)}`);
  // The decision snapshot records the composite, so bring it up to date first.
  await refreshQuietly(refreshScores(createAdminClient(), [parsed.data.application_id]));
  const { error } = await supabase.rpc("admin_decide", {
    p_application_id: parsed.data.application_id,
    p_decision: parsed.data.decision,
    p_reason: parsed.data.reason,
  });
  if (error) redirect(`/admin/candidates/${uid}?error=${encodeURIComponent(error.message)}`);
  redirect(`/admin/candidates/${uid}?ok=decision`);
}

const Reply = z.object({ user_id: z.uuid(), review_id: z.uuid(), response: z.string().trim().min(5).max(4000) });

async function respond(formData: FormData) {
  "use server";
  const { supabase, user } = await requireAdmin();
  const parsed = Reply.safeParse(Object.fromEntries(formData));
  const uid = String(formData.get("user_id"));
  if (!parsed.success) redirect(`/admin/candidates/${uid}?error=Reply is too short.`);
  const { error } = await supabase
    .from("review_requests")
    .update({ response: parsed.data.response, status: "responded", responded_by: user.id, responded_at: new Date().toISOString() })
    .eq("id", parsed.data.review_id);
  if (error) redirect(`/admin/candidates/${uid}?error=${encodeURIComponent(error.message)}`);
  redirect(`/admin/candidates/${uid}?ok=reply`);
}

export default async function CandidateDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { supabase, user } = await requireAdmin();
  const { id } = await params;
  const { error, ok } = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();

  const [profile, consents, cvs, attempts, flags, signals, applications, reviews] = await Promise.all([
    supabase.from("profiles").select("*").eq("user_id", id).maybeSingle(),
    supabase.from("consents").select("*").eq("user_id", id).order("accepted_at", { ascending: false }),
    supabase.from("cvs").select("id, storage_path, file_name, status, error, parsed, parse_model, prompt_version, injection_flags, created_at").eq("user_id", id).order("created_at", { ascending: false }),
    supabase.from("reasoning_attempts").select("id, form, started_at, deadline_at, submitted_at, raw_score, percentile, stars, norm_version, locked_at, tab_leaves").eq("user_id", id).order("started_at", { ascending: false }),
    supabase.from("dedupe_flags").select("*").or(`user_id.eq.${id},matched_user_id.eq.${id}`).order("created_at", { ascending: false }),
    supabase.from("signals").select("context, kind, payload, created_at").eq("user_id", id).order("created_at", { ascending: false }).limit(200),
    supabase.from("applications").select("id, stage, status, below_hurdle, reasoning_stars, created_at, roles(title), decisions(decision, reason, decided_at, stage)").eq("user_id", id),
    supabase.from("review_requests").select("*").eq("user_id", id).order("created_at", { ascending: false }),
  ]);
  if (!profile.data) notFound();
  const p = profile.data;

  const latestAttempt = attempts.data?.[0];
  const { data: responses } = latestAttempt
    ? await supabase.from("reasoning_responses").select("position, family, tier, served_at, answered_at, answer, answer_key, correct").eq("attempt_id", latestAttempt.id).order("position")
    : { data: [] };

  const scoreList = applications.data?.length ? await computeScores(createAdminClient(), { applicationIds: applications.data.map((a) => a.id) }) : [];
  const scoreOf = new Map(scoreList.map((x) => [x.applicationId, x]));
  // Live and final scores only as this panellist may see them (independent scoring, docs/09 §5).
  const liveGate = await viewerLiveGate(
    supabase,
    user.id,
    scoreList.map((x) => ({ applicationId: x.applicationId, roleSlug: x.roleSlug, preLive: x.preLive })),
  );

  const cv = cvs.data?.[0];
  const { data: signed } = cv ? await supabase.storage.from("cvs").createSignedUrl(cv.storage_path, 300) : { data: null };
  let brief: StoredBrief | null = null;
  let briefError: string | null = null;
  try {
    brief = await getBrief(createAdminClient(), id);
  } catch (e) {
    briefError = e instanceof Error ? e.message : "Could not load the brief";
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/candidates" className="muted underline">← All candidates</Link>
        <h1 className="h1 mt-2">{p.full_name || "(no name)"}</h1>
        <p className="muted">
          {p.email} · {p.phone_e164 ?? "no phone"} · {[p.city, p.province].filter(Boolean).join(", ") || "no location"}
        </p>
        <p className="muted">
          {p.linkedin_url && <a href={p.linkedin_url} className="underline" target="_blank" rel="noreferrer">LinkedIn</a>}{" "}
          {p.github_url && <a href={p.github_url} className="underline" target="_blank" rel="noreferrer">GitHub</a>}{" "}
          {p.portfolio_url && <a href={p.portfolio_url} className="underline" target="_blank" rel="noreferrer">Portfolio</a>}
        </p>
      </div>
      {error && <p className="error">{error}</p>}
      {ok && <p className="notice">Saved.</p>}

      <CandidateBriefCard userId={id} initial={brief} initialError={briefError} />

      <section className="card space-y-3">
        <h2 className="h2">Applications and decisions</h2>
        <p className="muted">Reasons are kept for 3 years in the decision archive after the candidate&apos;s data is purged: write about the evidence, not the person. Scores are advisory. Every advance or reject needs a reason of at least 20 characters that references the criteria (e.g. &quot;Below hurdle on reasoning (2★), but CV shows 4 years of directly relevant SQL work&quot;). The candidate can see your reason.</p>
        {applications.data?.map((a) => {
          const decisions = (a.decisions as unknown as { decision: string; reason: string; decided_at: string; stage: string }[]) ?? [];
          return (
            <div key={a.id} className="rounded border border-slate-200 p-3 text-sm">
              <p>
                <strong>{(a.roles as unknown as { title: string } | null)?.title}</strong> · {STAGE_LABEL[a.stage]} ·{" "}
                {STATUS_LABEL[a.status]} {a.below_hurdle && <span className="badge-warn">below reasoning hurdle ({a.reasoning_stars}★)</span>}
              </p>
              {(() => {
                const sc = scoreOf.get(a.id);
                if (!sc) return null;
                return (
                  <p className="muted" data-testid="composite">
                    Composite (pre-live) <strong>{sc.preLive.score ?? "—"}</strong>
                    {sc.preLive.score !== null && sc.preLive.coverage < 1 && <> ({Math.round(sc.preLive.coverage * 100)}% of stages; missing {sc.preLive.missing.join(", ")})</>}
                    {(() => {
                      const g = liveGate.get(a.id);
                      if (!g) return null;
                      return (
                        <>
                          {g.final !== null && <> · final <strong>{g.final}</strong></>}
                          {g.live.score !== null && <> · live {g.live.score}</>}
                          {g.hidden.length > 0 && <> · live scores you haven&apos;t submitted yourself stay hidden</>}
                        </>
                      );
                    })()}
                    {sc.execComms.score !== null && <> · exec comms {sc.execComms.score} (n={sc.execComms.n})</>}
                  </p>
                );
              })()}
              {decisions.map((d) => (
                <p key={d.decided_at} className="muted">{fmtDate(d.decided_at)} · {d.decision} at {d.stage}: {d.reason}</p>
              ))}
              <form action={decide} className="mt-2 flex flex-wrap items-start gap-2">
                <input type="hidden" name="user_id" value={id} />
                <input type="hidden" name="application_id" value={a.id} />
                <select name="decision" className="input w-32">
                  <option value="advance">Advance</option>
                  <option value="hold">Hold</option>
                  <option value="reject">Reject</option>
                </select>
                <textarea name="reason" required minLength={20} rows={2} className="input flex-1" placeholder="Reason, referencing criteria (min 20 characters)" />
                <button className="btn">Record decision</button>
              </form>
            </div>
          );
        })}
        {!applications.data?.length && <p className="muted">No applications yet.</p>}
      </section>

      <SessionControls userId={id} />

      {applications.data?.map((a) => (
        <section key={`detail-${a.id}`} className="space-y-4">
          <h2 className="h2">{(a.roles as unknown as { title: string } | null)?.title}: assessment detail</h2>
          <InterviewPanel applicationId={a.id} />
          <QuizPanel applicationId={a.id} />
          <WorkPanel applicationId={a.id} />
          <WorkGrades applicationId={a.id} />
        </section>
      ))}

      <section className="card space-y-2">
        <h2 className="h2">Dedupe flags</h2>
        {flags.data?.length ? (
          <table className="table">
            <thead><tr><th>Kind</th><th>Other account</th><th>Similarity</th><th>Fields</th><th>Status</th></tr></thead>
            <tbody>
              {flags.data.map((f) => {
                const other = f.user_id === id ? f.matched_user_id : f.user_id;
                return (
                  <tr key={f.id}>
                    <td><span className={f.kind === "semantic_review" ? "badge-warn" : "badge-bad"}>{f.kind}</span></td>
                    <td><Link href={`/admin/candidates/${other}`} className="underline">{other.slice(0, 8)}</Link></td>
                    <td>{f.similarity ?? "—"}</td>
                    <td>{(f.matched_fields ?? []).join(", ")}</td>
                    <td>{f.status} {f.status === "open" && <Link href="/admin/dedupe" className="underline">resolve</Link>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="muted">None.</p>}
      </section>

      <section className="card space-y-2">
        <h2 className="h2">Reasoning Assessment</h2>
        {attempts.data?.map((a) => (
          <p key={a.id} className="text-sm">
            {fmtDate(a.started_at)} · {a.form} ·{" "}
            {a.submitted_at ? <>{a.raw_score}/30 · P{Math.round(Number(a.percentile))} · {a.stars}★ ({a.norm_version})</> : a.locked_at ? <span className="badge-warn">locked</span> : "in progress"}
            {a.tab_leaves > 0 && <span className="muted"> · tab leaves {a.tab_leaves}</span>}
          </p>
        ))}
        {!!responses?.length && (
          <details>
            <summary className="cursor-pointer text-sm underline">Item-level responses (latest attempt)</summary>
            <table className="table mt-2">
              <thead><tr><th>#</th><th>Family</th><th>Tier</th><th>Time</th><th>Answer</th><th>Key</th><th>Correct</th></tr></thead>
              <tbody>
                {responses.map((r) => (
                  <tr key={r.position}>
                    <td>{r.position}</td><td>{r.family}</td><td>{r.tier}</td>
                    <td>{r.served_at && r.answered_at ? `${((new Date(r.answered_at).getTime() - new Date(r.served_at).getTime()) / 1000).toFixed(1)}s` : "—"}</td>
                    <td>{r.answered_at ? (r.answer == null ? "skipped" : r.answer + 1) : "—"}</td>
                    <td>{r.answer_key + 1}</td>
                    <td>{r.correct == null ? "—" : r.correct ? "✓" : "✗"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
        {!attempts.data?.length && <p className="muted">Not started.</p>}
      </section>

      <section className="card space-y-2">
        <h2 className="h2">CV</h2>
        {cv ? (
          <>
            <p className="text-sm">
              {cv.file_name} · {cv.status} · {fmtDate(cv.created_at)}{" "}
              {signed?.signedUrl && <a href={signed.signedUrl} className="underline" target="_blank" rel="noreferrer">Download</a>}
            </p>
            {cv.error && <p className="error">{cv.error}</p>}
            {!!cv.injection_flags?.length && <p className="badge-bad">Injection-like text found: {cv.injection_flags.join(", ")}</p>}
            {cv.parsed && (
              <details>
                <summary className="cursor-pointer text-sm underline">Parsed profile ({cv.parse_model}, {cv.prompt_version})</summary>
                <pre className="mt-2 max-h-96 overflow-auto rounded bg-slate-50 p-3 text-xs">{JSON.stringify(cv.parsed, null, 2)}</pre>
              </details>
            )}
            {(cvs.data?.length ?? 0) > 1 && <p className="muted">{cvs.data!.length} CVs uploaded in total.</p>}
          </>
        ) : <p className="muted">No CV.</p>}
      </section>

      <section className="card space-y-2">
        <h2 className="h2">Review requests</h2>
        {reviews.data?.map((r) => (
          <div key={r.id} className="rounded border border-slate-200 p-3 text-sm">
            <p className="muted">{fmtDate(r.created_at)} · {r.stage} · {r.status}</p>
            <p>{r.message}</p>
            {r.response ? (
              <p className="mt-1 border-l-2 border-slate-300 pl-2">Reply: {r.response}</p>
            ) : (
              <form action={respond} className="mt-2 flex gap-2">
                <input type="hidden" name="user_id" value={id} />
                <input type="hidden" name="review_id" value={r.id} />
                <textarea name="response" required minLength={5} rows={2} className="input flex-1" placeholder="Reply to the candidate" />
                <button className="btn">Reply</button>
              </form>
            )}
          </div>
        ))}
        {!reviews.data?.length && <p className="muted">None.</p>}
      </section>

      <section className="card space-y-2">
        <h2 className="h2">Signals ({signals.data?.length ?? 0})</h2>
        <p className="muted">Context only. Signals are never evidence on their own.</p>
        {!!signals.data?.length && (
          <table className="table">
            <thead><tr><th>When</th><th>Where</th><th>Kind</th><th>Detail</th></tr></thead>
            <tbody>
              {signals.data.map((s, i) => (
                <tr key={i}><td>{fmtDate(s.created_at)}</td><td>{s.context}</td><td>{s.kind}</td><td className="text-xs">{JSON.stringify(s.payload)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card space-y-1 text-sm">
        <h2 className="h2">Consent</h2>
        {consents.data?.map((c) => (
          <p key={c.id}>{fmtDate(c.accepted_at)} · notice {c.notice_version} · talent pool: {c.talent_pool_opt_in ? "yes" : "no"}</p>
        ))}
        {!consents.data?.length && <p className="muted">Not given.</p>}
      </section>
    </div>
  );
}
