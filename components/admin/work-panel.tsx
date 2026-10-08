import { createClient } from "@/lib/supabase/server";
import HarnessPanel from "@/components/admin/harness-panel";
import { createAdminClient } from "@/lib/supabase/admin";
import { processSubmission, PROCESS_RECOVERY_MS } from "@/lib/server/work";
import { elicitationPoints, elicitationYield } from "@/lib/persona/facts";
import { fmtDate } from "@/lib/format";
import { displayName } from "@/lib/work/stages";

/**
 * Admin view of one application's work assessments (BA Part 1/2, SWE Test 1/2): the clocks,
 * what was submitted (signed links to files and snapshots), the repo SHA graded, word/page
 * counts, injection flags, and for BA Part 1 the persona transcript with the facts revealed per
 * message and the elicitation yield. Reads with the admin's own session (RLS: admin-only SELECT),
 * so it shows nothing if embedded by mistake. The rubric breakdown lives in its own component.
 * Scores are advisory: people decide.
 */

type Attempt = {
  id: string;
  unlocked_at: string;
  open_until: string;
  started_at: string | null;
  deadline_at: string | null;
  submitted_at: string | null;
  draft_saved_at: string | null;
  work_stages: { key: string; title: string; word_limit: number | null; page_limit: number | null; dataset_bundle: string | null } | null;
};

type UrlSnap = {
  field?: string;
  status: number | null;
  final_url: string | null;
  sha256: string | null;
  bytes?: number;
  truncated?: boolean;
  path: string | null;
  error: string | null;
  captured_at?: string;
  late?: boolean;
};
type Snapshot = {
  captured_at?: string;
  urls?: Record<string, UrlSnap>;
  submitted_at?: string;
  repo?: { owner: string; repo: string; sha: string | null; error: string | null; resolved_at?: string; after_submission?: boolean; late?: boolean };
};
type ReviewFlag = { kind: string; detail?: string };
type Flag = { source: string; via: string; flags?: string[]; noul?: number; model?: string; flagged?: boolean; error?: string };
type Submission = {
  id: string;
  attempt_id: string;
  stage_key: string;
  files: string[];
  repo_url: string | null;
  repo_commit_sha: string | null;
  deployed_url: string | null;
  mvp_url: string | null;
  doc_url: string | null;
  loom_url: string | null;
  loom_transcript: string | null;
  test_logins: string | null;
  snapshot: Snapshot;
  word_count: number | null;
  word_count_total: number | null;
  page_count: number | null;
  injection_flags: Flag[];
  review_flags: ReviewFlag[] | null;
  score: number | null;
  grading_status: string;
  created_at: string;
};
type PersonaMessage = { id: string; role: "candidate" | "persona"; content: string; revealed_fact_ids: string[]; meta: Record<string, unknown> | null; created_at: string };
type Fact = { id: string; fact: string; weight: number };

const SUB_COLS =
  "id, attempt_id, stage_key, files, repo_url, repo_commit_sha, deployed_url, mvp_url, doc_url, loom_url, loom_transcript, test_logins, snapshot, word_count, word_count_total, page_count, injection_flags, review_flags, score, grading_status, created_at";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <th className="w-48 whitespace-nowrap">{label}</th>
      <td>{children}</td>
    </tr>
  );
}

function ExternalLink({ url }: { url: string | null }) {
  if (!url) return <span className="muted">—</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="break-all underline">
      {url}
    </a>
  );
}

export default async function WorkPanel({ applicationId }: { applicationId: string }) {
  const supabase = await createClient();
  const { data: attemptRows } = await supabase
    .from("work_attempts")
    .select("id, unlocked_at, open_until, started_at, deadline_at, submitted_at, draft_saved_at, work_stages(key, title, word_limit, page_limit, dataset_bundle)")
    .eq("application_id", applicationId)
    .order("unlocked_at");
  const attempts = (attemptRows ?? []) as unknown as Attempt[];

  if (!attempts.length) {
    const { data: app } = await supabase.from("applications").select("stage, status").eq("id", applicationId).maybeSingle();
    const atWork = app?.stage === "work_1" || app?.stage === "work_2";
    return (
      <section className="card">
        <h2 className="h2">Work assessments</h2>
        <p className="muted">
          {atWork
            ? `The application is at ${app?.stage} (${app?.status}) but has no attempt yet: either the stage isn't active for this role, or the attempt is created when the candidate opens it (its start window still runs from the advance decision).`
            : "Not unlocked yet. A work stage unlocks when an admin advances the application to it; the start window runs from that decision."}
        </p>
      </section>
    );
  }

  const ids = attempts.map((a) => a.id);
  const readSubs = () => supabase.from("submissions").select(SUB_COLS).in("attempt_id", ids);
  let { data: subRows } = await readSubs();

  // A submission left 'pending' (the request died before its snapshot and grading queue) is
  // finished here as well as by the cron backstop. The rows were readable through RLS, so the
  // viewer is an admin; the service role touches only these submissions.
  const stale = ((subRows ?? []) as Submission[]).filter(
    (s) => s.grading_status === "pending" && Date.now() - new Date(s.created_at).getTime() > PROCESS_RECOVERY_MS,
  );
  if (stale.length) {
    const admin = createAdminClient();
    for (const s of stale) await processSubmission(admin, s.id).catch((e) => console.error("work panel: recovery failed", s.id, e));
    ({ data: subRows } = await readSubs());
  }
  const subs = new Map(((subRows ?? []) as Submission[]).map((s) => [s.attempt_id, s]));

  const [jobs, sessions, facts] = await Promise.all([
    subs.size
      ? supabase.from("grading_jobs").select("subject_id, status, attempts, last_error").eq("subject_type", "submission").in("subject_id", [...subs.values()].map((s) => s.id))
      : Promise.resolve({ data: [] as { subject_id: string; status: string; attempts: number; last_error: string | null }[] }),
    supabase.from("persona_sessions").select("id, attempt_id, started_at, deadline_at, ended_at, candidate_messages, revealed_fact_ids").in("attempt_id", ids),
    supabase.from("persona_facts").select("id, fact, weight").eq("persona_key", "lerato").order("id"),
  ]);
  const jobBy = new Map((jobs.data ?? []).map((j) => [j.subject_id as string, j]));
  const sessionBy = new Map((sessions.data ?? []).map((s) => [s.attempt_id as string, s]));
  const factList = (facts.data ?? []) as Fact[];
  const factBy = new Map(factList.map((f) => [f.id, f]));

  // Signed links (5 minutes) to submitted files and stored snapshots, with the admin's session.
  const sign = async (bucket: string, path: string) => {
    const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 300);
    return data?.signedUrl ?? null;
  };

  const blocks = await Promise.all(
    attempts.map(async (a) => {
      const sub = subs.get(a.id) ?? null;
      const stage = a.work_stages;
      const fileLinks = sub ? await Promise.all(sub.files.map(async (p) => ({ name: displayName(p), url: await sign("submissions", p) }))) : [];
      const snaps = sub?.snapshot?.urls
        ? await Promise.all(Object.entries(sub.snapshot.urls).map(async ([url, s]) => ({ url, s, link: s.path ? await sign("snapshots", s.path) : null })))
        : [];
      const session = sessionBy.get(a.id);
      const messages = session
        ? (((await supabase.from("persona_messages").select("id, role, content, revealed_fact_ids, meta, created_at").eq("session_id", session.id).order("created_at").order("id")).data ??
            []) as PersonaMessage[])
        : [];
      return { a, sub, stage, fileLinks, snaps, session, messages, job: sub ? jobBy.get(sub.id) : undefined };
    }),
  );

  return (
    <section className="card space-y-6">
      <h2 className="h2">Work assessments</h2>
      {blocks.map(({ a, sub, stage, fileLinks, snaps, session, messages, job }) => {
        const flags = sub?.injection_flags ?? [];
        const flagged = flags.some((f) => (f.via === "regex" && f.flags?.includes("prompt_injection")) || (f.via === "jev" && f.flagged));
        const revealed = (session?.revealed_fact_ids as string[] | undefined) ?? [];
        const pts = elicitationPoints(revealed, factList);
        return (
          <div key={a.id} className="space-y-3 border-t border-slate-100 pt-4 first:border-t-0 first:pt-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold">
                {stage?.title ?? "Work stage"} <span className="badge">{stage?.key}</span>
              </h3>
              <p className="text-sm">
                {sub ? (
                  <>
                    {sub.score !== null ? <strong>{Number(sub.score).toFixed(1)}/100</strong> : <span className="muted">not scored</span>} · grading {sub.grading_status}
                    {job && (
                      <span className="muted">
                        {" "}
                        (job {job.status}, attempts {job.attempts})
                      </span>
                    )}
                    {job?.last_error && <span className="badge-bad ml-1">{String(job.last_error).slice(0, 120)}</span>}
                  </>
                ) : (
                  <span className="muted">no submission</span>
                )}
              </p>
            </div>
            <p className="muted">
              Unlocked {fmtDate(a.unlocked_at)} · start by {fmtDate(a.open_until)} · started {fmtDate(a.started_at)} · deadline {fmtDate(a.deadline_at)} · submitted{" "}
              {fmtDate(a.submitted_at)}
              {a.draft_saved_at && <> · last autosave {fmtDate(a.draft_saved_at)}</>}
            </p>

            {sub && (
              <table className="table">
                <tbody>
                  {fileLinks.length > 0 && (
                    <Row label="Files">
                      <ul className="space-y-1">
                        {fileLinks.map((f) => (
                          <li key={f.name}>{f.url ? <a href={f.url} className="underline" target="_blank" rel="noopener noreferrer">{f.name}</a> : f.name}</li>
                        ))}
                      </ul>
                    </Row>
                  )}
                  {sub.repo_url && (
                    <Row label="Repository">
                      <ExternalLink url={sub.repo_url} />
                      <p className="text-xs">
                        Graded commit:{" "}
                        {sub.repo_commit_sha ? <code className="font-mono">{sub.repo_commit_sha}</code> : <span className="badge-warn">not recorded</span>}
                        {sub.snapshot?.repo?.resolved_at && <span className="muted"> · resolved {fmtDate(sub.snapshot.repo.resolved_at)}</span>}
                        {sub.snapshot?.repo?.after_submission && !sub.snapshot.repo.late && <span className="muted"> (after the freeze)</span>}
                        {sub.snapshot?.repo?.late && <span className="badge-warn ml-1">resolved late: later pushes may be included</span>}
                        {sub.snapshot?.repo?.error && <span className="muted"> ({sub.snapshot.repo.error})</span>}
                      </p>
                    </Row>
                  )}
                  {sub.deployed_url && (
                    <Row label="Deployed URL">
                      <ExternalLink url={sub.deployed_url} />
                    </Row>
                  )}
                  {sub.doc_url && (
                    <Row label="Google Doc (live)">
                      <ExternalLink url={sub.doc_url} />{" "}
                      <span className="muted">The graded copy is the file saved at submission.</span>
                    </Row>
                  )}
                  {sub.mvp_url && (
                    <Row label="MVP">
                      <ExternalLink url={sub.mvp_url} />
                    </Row>
                  )}
                  {sub.loom_url && (
                    <Row label="Loom">
                      <ExternalLink url={sub.loom_url} />
                    </Row>
                  )}
                  {sub.loom_transcript && (
                    <Row label="Loom transcript">
                      <details>
                        <summary className="cursor-pointer text-sm">{sub.loom_transcript.split(/\s+/).length} words (sanitised)</summary>
                        <p className="mt-2 whitespace-pre-line text-sm">{sub.loom_transcript}</p>
                      </details>
                    </Row>
                  )}
                  {sub.test_logins && (
                    <Row label="Test logins">
                      <details>
                        <summary className="cursor-pointer text-sm">Show</summary>
                        <pre className="mt-2 whitespace-pre-wrap text-xs">{sub.test_logins}</pre>
                      </details>
                    </Row>
                  )}
                  {(sub.word_count !== null || sub.page_count !== null) && (
                    <Row label="Length">
                      {sub.word_count !== null && (
                        <>
                          {sub.word_count.toLocaleString("en-US")} words{sub.stage_key === "ba_part1" ? " in the body (before the first “Appendix” heading)" : ""}
                          {stage?.word_limit ? ` / limit ${stage.word_limit.toLocaleString("en-US")}` : ""}
                          {sub.word_count_total !== null && sub.word_count_total !== sub.word_count && (
                            <span className="muted"> · {sub.word_count_total.toLocaleString("en-US")} in the whole document</span>
                          )}
                        </>
                      )}
                      {sub.page_count !== null && (
                        <>
                          {" · "}
                          {sub.page_count} pages{stage?.page_limit ? ` / limit ${stage.page_limit}` : ""}
                        </>
                      )}
                    </Row>
                  )}
                  {(sub.review_flags ?? []).length > 0 && (
                    <Row label="Check by hand">
                      <ul className="space-y-1">
                        {(sub.review_flags ?? []).map((f, i) => (
                          <li key={i}>
                            <span className="badge-warn">{f.kind.replace(/_/g, " ")}</span> <span className="text-sm">{f.detail}</span>
                          </li>
                        ))}
                      </ul>
                      <p className="muted">Review flags only: never evidence or a decision on their own.</p>
                    </Row>
                  )}
                  <Row label="Injection screen">
                    {flags.length === 0 ? (
                      <span className="muted">nothing found</span>
                    ) : (
                      <ul className="space-y-1">
                        {flags.map((f, i) => (
                          <li key={i}>
                            {f.via === "regex" ? (
                              <span className={f.flags?.includes("prompt_injection") ? "badge-bad" : "badge-warn"}>
                                {f.source}: {f.flags?.join(", ")}
                              </span>
                            ) : f.error ? (
                              <span className="muted">JEV pre-screen unavailable ({f.error})</span>
                            ) : (
                              <span className={f.flagged ? "badge-bad" : "badge"}>
                                JEV pre-screen {f.noul?.toFixed(2)} ({f.model})
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {flagged && <p className="muted">Signal only: hidden text was stripped and graders ignore instructions in submissions. Never evidence on its own.</p>}
                  </Row>
                  <Row label="Snapshots">
                    {snaps.length === 0 ? (
                      <span className="muted">{sub.grading_status === "pending" ? "being captured" : "no links"}</span>
                    ) : (
                      <ul className="space-y-2">
                        {snaps.map(({ url, s, link }) => (
                          <li key={url} className="text-xs">
                            <span className="badge">{s.field ?? "url"}</span> <span className="break-all">{url}</span>
                            <br />
                            {s.error ? (
                              <span className="badge-warn">{s.error}</span>
                            ) : (
                              <>
                                HTTP {s.status} · {s.final_url && s.final_url !== url ? <>final {s.final_url} · </> : null}
                                sha256 <code className="font-mono">{s.sha256?.slice(0, 16)}…</code> · {s.bytes?.toLocaleString("en-US")} bytes
                                {s.truncated && " (truncated at 2 MB)"}
                                {link && (
                                  <>
                                    {" "}
                                    ·{" "}
                                    <a href={link} className="underline" target="_blank" rel="noopener noreferrer">
                                      stored HTML (as text)
                                    </a>
                                  </>
                                )}
                              </>
                            )}
                            {s.captured_at && <span className="muted"> · {fmtDate(s.captured_at)}</span>}
                            {s.late && <span className="badge-warn ml-1">captured late</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Row>
                </tbody>
              </table>
            )}

            {stage?.key === "ba_part1" && (
              <div className="space-y-2">
                <p className="font-medium">
                  Client chat (Lerato){" "}
                  {session ? (
                    <span className="text-sm font-normal">
                      · elicitation yield <strong>{Math.round(elicitationYield(revealed, factList) * 100)}%</strong> ({pts.points}/{pts.max} weighted points) ·{" "}
                      {session.candidate_messages as number} candidate messages · {session.ended_at ? `ended ${fmtDate(session.ended_at as string)}` : `deadline ${fmtDate(session.deadline_at as string)}`}
                    </span>
                  ) : (
                    <span className="muted">· not opened</span>
                  )}
                </p>
                {session && (
                  <>
                    <p className="text-xs">
                      Revealed:{" "}
                      {revealed.length ? revealed.map((id) => <span key={id} className="badge mr-1" title={factBy.get(id)?.fact}>{id} (w{factBy.get(id)?.weight})</span>) : <span className="muted">none</span>}
                      {" · "}Not revealed:{" "}
                      {factList
                        .filter((f) => !revealed.includes(f.id))
                        .map((f) => (
                          <span key={f.id} className="mr-1 text-slate-400" title={f.fact}>
                            {f.id}
                          </span>
                        ))}
                    </p>
                    <details>
                      <summary className="cursor-pointer text-sm">Transcript ({messages.length} messages)</summary>
                      <ol className="mt-2 space-y-2 text-sm">
                        {messages.map((m) => {
                          const meta = m.meta ?? {};
                          return (
                            <li key={m.id} className={m.role === "candidate" ? "rounded bg-slate-50 p-2" : "p-2"}>
                              <p className="text-xs text-slate-500">
                                {m.role === "candidate" ? "Candidate" : "Lerato"} · {fmtDate(m.created_at)}
                                {m.role === "persona" && typeof meta.via === "string" && (
                                  <>
                                    {" "}
                                    · gate {meta.via}
                                    {Array.isArray(meta.gated) && (meta.gated as string[]).length ? ` (allowed ${(meta.gated as string[]).join(", ")})` : ""}
                                    {Array.isArray(meta.hits) && (meta.hits as string[]).length > (Array.isArray(meta.gated) ? (meta.gated as string[]).length : 0)
                                      ? ` (asked about ${(meta.hits as string[]).join(", ")})`
                                      : ""}
                                  </>
                                )}
                                {meta.off_script === true && <span className="badge-warn ml-1">off-script ({String(meta.off_script_via ?? "")})</span>}
                                {meta.refunded === true && (
                                  <span className="badge ml-1">not counted ({meta.refund_reason === "off_script_hint" ? "off-script hint, no signal" : "model error"})</span>
                                )}
                              </p>
                              <p className="whitespace-pre-line">{m.content}</p>
                              {m.revealed_fact_ids?.length > 0 && (
                                <p className="mt-1 text-xs">
                                  Revealed:{" "}
                                  {m.revealed_fact_ids.map((id) => (
                                    <span key={id} className="badge mr-1" title={factBy.get(id)?.fact}>
                                      {id}
                                    </span>
                                  ))}
                                </p>
                              )}
                            </li>
                          );
                        })}
                      </ol>
                    </details>
                  </>
                )}
              </div>
            )}
            {sub && stage?.key === "swe_test1" && <HarnessPanel submissionId={sub.id} />}
          </div>
        );
      })}
    </section>
  );
}

export { WorkPanel };
