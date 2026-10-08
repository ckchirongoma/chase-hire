import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { CHECK_KEYS, CHECK_LABELS, DATA_CHECKS, IMPORT_CHECKS, kindOf, REPO_CHECKS, URL_CHECKS, type CheckKey } from "@/lib/harness/checks";
import { dispatchConfig, localRepoCheckCommands } from "@/lib/harness/github";
import { FLASH_COOKIE, readFlash } from "@/lib/server/harness";
import { fmtDate } from "@/lib/format";

/**
 * Admin panel for the SWE Test 1 verification harness (docs/07): the latest result per check
 * with its evidence, buttons for the URL checks, the month-2 import checks (mutating, so they
 * need a tick-box confirm) and the repo checks, a form to record a manual result, and
 * "Re-grade with harness results". Reads with the admin's own session (RLS: admin-only), so it
 * shows nothing if embedded for anyone else. Buttons are plain form posts to
 * /api/admin/harness/{id}/…, which redirect back here with a short-lived message.
 *
 * Results are advisory evidence for the grader and the reviewer; nothing here decides.
 */

type Run = { id: string; check_key: string; passed: boolean | null; manual: boolean; detail: Record<string, unknown> | null; ran_at: string };
type HRun = { id: string; kind: string; status: string; started_at: string; finished_at: string | null; summary: Record<string, unknown> | null };

const GROUPS: { title: string; keys: readonly CheckKey[]; note?: string }[] = [
  { title: "Repo (commit SHA)", keys: REPO_CHECKS },
  { title: "Deployed URL", keys: URL_CHECKS },
  { title: "Month-2 import", keys: IMPORT_CHECKS },
  { title: "Data", keys: DATA_CHECKS },
];

function Result({ run }: { run: Run | undefined }) {
  if (!run) return <span className="muted">not run</span>;
  const inconclusive = run.detail?.inconclusive === true;
  if (run.passed === true) return <span className="inline-block rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">PASS</span>;
  if (run.passed === false) return <span className="badge-bad">FAIL</span>;
  return <span className={inconclusive ? "badge-warn" : "badge"}>{inconclusive ? "INCONCLUSIVE" : "INFO"}</span>;
}

function Evidence({ detail }: { detail: Record<string, unknown> | null }) {
  if (!detail) return null;
  const { summary: _summary, ...rest } = detail;
  void _summary;
  if (!Object.keys(rest).length) return null;
  return (
    <details>
      <summary className="cursor-pointer text-xs text-slate-500">Evidence</summary>
      <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 text-xs">{JSON.stringify(rest, null, 2)}</pre>
    </details>
  );
}

const field = "mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm";

export default async function HarnessPanel({ submissionId }: { submissionId: string }) {
  const supabase = await createClient();
  const [{ data: sub }, { data: runRows }, { data: harnessRows }, jar] = await Promise.all([
    supabase.from("submissions").select("id, stage_key, repo_url, repo_commit_sha, deployed_url, snapshot").eq("id", submissionId).maybeSingle(),
    supabase.from("verification_runs").select("id, check_key, passed, manual, detail, ran_at").eq("submission_id", submissionId).order("ran_at", { ascending: false }).limit(500),
    supabase.from("harness_runs").select("id, kind, status, started_at, finished_at, summary").eq("submission_id", submissionId).order("started_at", { ascending: false }).limit(20),
    cookies(),
  ]);
  if (!sub || sub.stage_key !== "swe_test1") return null;

  const runs = (runRows ?? []) as Run[];
  const latest = new Map<string, Run>();
  const history = new Map<string, number>();
  for (const r of runs) {
    if (!latest.has(r.check_key)) latest.set(r.check_key, r);
    history.set(r.check_key, (history.get(r.check_key) ?? 0) + 1);
  }
  const lastOf = (kind: string) => ((harnessRows ?? []) as HRun[]).find((h) => h.kind === kind);
  /** The latest run of this check's kind came back inconclusive and kept the earlier result (not written). */
  const keptNote = (k: CheckKey, shown: Run | undefined): string | null => {
    const kind = kindOf(k) === "data" ? "import" : kindOf(k);
    const h = lastOf(kind);
    const kept = Array.isArray(h?.summary?.kept_earlier) ? (h.summary.kept_earlier as { key?: unknown; reason?: unknown }[]) : [];
    const hit = kept.find((x) => x?.key === k);
    if (!h || !hit || (shown && new Date(h.started_at) < new Date(shown.ran_at))) return null;
    return `The run of ${fmtDate(h.started_at)} could not decide (${String(hit.reason ?? "").slice(0, 200)}); the result above stands.`;
  };
  const flash = readFlash(jar.get(FLASH_COOKIE)?.value, submissionId);
  const sha = (sub.repo_commit_sha as string | null) ?? ((sub.snapshot as { repo?: { sha?: string | null } } | null)?.repo?.sha ?? null);
  const commands = sub.repo_url && sha ? localRepoCheckCommands({ submissionId, repoUrl: sub.repo_url as string, sha }) : [];
  const dispatch = dispatchConfig();
  const action = (p: string) => `/api/admin/harness/${submissionId}/${p}`;
  const counts = {
    pass: [...latest.values()].filter((r) => r.passed === true).length,
    fail: [...latest.values()].filter((r) => r.passed === false).length,
    open: CHECK_KEYS.filter((k) => !latest.has(k) || latest.get(k)!.passed === null).length,
  };

  const LastRun = ({ kind }: { kind: string }) => {
    const h = lastOf(kind);
    if (!h) return <p className="text-xs text-slate-500">Never run.</p>;
    const err = typeof h.summary?.error === "string" ? h.summary.error : null;
    return (
      <p className="text-xs text-slate-500">
        Last: {h.status} · started {fmtDate(h.started_at)}
        {h.finished_at && <> · finished {fmtDate(h.finished_at)}</>}
        {err && <span className="badge-warn ml-1">{err.slice(0, 160)}</span>}
        {typeof h.summary?.run_url === "string" && h.summary.run_url.startsWith("https://github.com/") && (
          <>
            {" "}
            ·{" "}
            <a className="underline" href={h.summary.run_url} target="_blank" rel="noopener noreferrer">
              workflow run
            </a>
          </>
        )}
      </p>
    );
  };

  return (
    <section id={`harness-${submissionId}`} className="card space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="h2">Verification harness (SWE Test 1)</h2>
        <p className="text-sm">
          {counts.pass} pass · {counts.fail} fail · {counts.open} not run or inconclusive
        </p>
      </div>
      <p className="muted">
        Automated evidence for the grader and for you. Latest result per check (a manual result counts like any other run). Inconclusive means the check could not decide: record a manual result.
        A later run that cannot decide never replaces a pass, a fail or your manual result.
        Results never change an application&apos;s status.
      </p>

      {flash && (
        <p className={flash.ok ? "notice" : "error"}>
          {flash.msg} <span className="text-xs opacity-70">({fmtDate(flash.at)})</span>
        </p>
      )}

      {GROUPS.map((g) => (
        <div key={g.title}>
          <h3 className="mb-1 font-semibold">{g.title}</h3>
          <table className="table">
            <tbody>
              {g.keys.map((k) => {
                const r = latest.get(k);
                const reason = typeof r?.detail?.reason === "string" ? r.detail.reason : null;
                const note = typeof r?.detail?.reviewer_note === "string" ? r.detail.reviewer_note : null;
                const kept = keptNote(k, r);
                return (
                  <tr key={k}>
                    <th className="w-14 whitespace-nowrap">{k}</th>
                    <td className="w-64">{CHECK_LABELS[k]}</td>
                    <td className="w-32">
                      <Result run={r} />
                      {r?.manual && <span className="badge ml-1">manual</span>}
                    </td>
                    <td>
                      {r ? (
                        <>
                          <p className="text-sm">{String(r.detail?.summary ?? "").slice(0, 400)}</p>
                          {reason && r.passed !== null ? <p className="text-xs text-slate-500">{reason}</p> : null}
                          {note && <p className="text-xs text-amber-800">Check by hand: {note}</p>}
                          {kept && <p className="text-xs text-slate-500">{kept}</p>}
                          <p className="text-xs text-slate-400">
                            {fmtDate(r.ran_at)}
                            {(history.get(k) ?? 0) > 1 && ` · ${history.get(k)} runs`}
                          </p>
                          <Evidence detail={r.detail} />
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      <div className="grid gap-4 md:grid-cols-2">
        <form method="post" action={action("url")} className="space-y-2 rounded-md border border-slate-200 p-3">
          <h3 className="font-semibold">URL checks (U1–U8)</h3>
          <p className="muted">
            Probes the deployed app as anonymous, agent A, agent B and the manager. Writes a few labelled probe rows (notes start with &quot;Verification harness probe&quot;), sends about 200
            requests to /api/summary, and asks the MDN Observatory to scan the host. Up to 5 minutes.
          </p>
          <p className="muted">
            Apps that keep Supabase server-side ship no publishable key: the harness then signs in through the app&apos;s login form and tests the app&apos;s routes, but the database
            probes (U3, and the REST halves of U4, U6, U7, plus all import checks) need the project&apos;s publishable key. It is read from a &quot;supabase: &lt;URL&gt; / &lt;publishable
            key&gt;&quot; line in the test logins, or enter it here (it is public by design; never a secret or service-role key).
          </p>
          <details>
            <summary className="cursor-pointer text-xs text-slate-500">Supabase URL / publishable key (if the bundle and the logins do not have them)</summary>
            <label className="mt-2 block text-xs">
              Supabase URL
              <input name="supabase_url" type="url" className={field} placeholder="https://xyz.supabase.co" />
            </label>
            <label className="mt-2 block text-xs">
              Publishable (anon) key
              <input name="anon_key" className={field} autoComplete="off" />
            </label>
          </details>
          <button className="btn-secondary" type="submit">
            Run URL checks
          </button>
          <LastRun kind="url" />
        </form>

        <form method="post" action={action("import")} className="space-y-2 rounded-md border border-amber-200 bg-amber-50/40 p-3">
          <h3 className="font-semibold">Month-2 import checks (M1–M7, D-a–D-c)</h3>
          <p className="muted">
            Signs in as the manager and uploads the held-back month-2 file twice and the drift file once to the candidate&apos;s /api/import. This <strong>changes data</strong> in their
            deployed database. Run it once, after the URL checks. A second run skips M1–M5 (month 2 is already in).
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="confirm" value="yes" required className="mt-1" />
            <span>I understand this writes month-2 data into the candidate&apos;s deployment.</span>
          </label>
          <details>
            <summary className="cursor-pointer text-xs text-slate-500">Supabase URL / key override</summary>
            <label className="mt-2 block text-xs">
              Supabase URL
              <input name="supabase_url" type="url" className={field} />
            </label>
            <label className="mt-2 block text-xs">
              Publishable (anon) key
              <input name="anon_key" className={field} autoComplete="off" />
            </label>
          </details>
          <button className="btn-secondary" type="submit">
            Run import checks
          </button>
          <LastRun kind="import" />
        </form>

        <form method="post" action={action("repo")} className="space-y-2 rounded-md border border-slate-200 p-3">
          <h3 className="font-semibold">Repo checks (R1–R7)</h3>
          {sha ? (
            <p className="muted">
              Graded commit <code className="font-mono">{sha.slice(0, 12)}</code>.{" "}
              {dispatch ? (
                <>Runs in GitHub Actions ({dispatch.repo}): the candidate&apos;s code runs in a job with no secrets, and a separate job records the results here.</>
              ) : (
                <>GitHub dispatch is not configured (GITHUB_ACTIONS_TOKEN, GITHUB_ACTIONS_REPO). Run these from the platform repo instead:</>
              )}
            </p>
          ) : (
            <p className="notice">No commit SHA was recorded at submission, so there is no fixed commit to check. Record R1–R7 by hand.</p>
          )}
          {commands.length > 0 && (
            <details open={!dispatch}>
              <summary className="cursor-pointer text-xs text-slate-500">Local commands</summary>
              <pre className="mt-1 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 text-xs">{commands.join("\n\n")}</pre>
              <p className="text-xs text-slate-500">
                These run the static checks only (R1, R2, R3 without the db reset, R6, R7); R4 and R5 stay inconclusive. They never run the candidate&apos;s code. The build, tests and db
                reset run the candidate&apos;s code, so they run only in GitHub Actions or a throwaway VM (--disposable-sandbox --exec --db-reset), never on a machine with platform
                credentials or a local Supabase. Record R4/R5 by hand if you cannot dispatch.
              </p>
            </details>
          )}
          {sha && dispatch && (
            <button className="btn-secondary" type="submit">
              Run repo checks
            </button>
          )}
          <LastRun kind="repo" />
        </form>

        <form method="post" action={action("manual")} className="space-y-2 rounded-md border border-slate-200 p-3">
          <h3 className="font-semibold">Record a manual result</h3>
          <label className="block text-xs">
            Check
            <select name="check_key" className={field} required defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {CHECK_KEYS.map((k) => (
                <option key={k} value={k}>
                  {k}: {CHECK_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="flex gap-4 text-sm">
            {(["pass", "fail", "info"] as const).map((v) => (
              <label key={v} className="flex items-center gap-1">
                <input type="radio" name="result" value={v} required /> {v === "info" ? "informational" : v}
              </label>
            ))}
          </fieldset>
          <label className="block text-xs">
            What you checked and saw
            <textarea name="note" className={field} rows={3} minLength={10} maxLength={2000} required />
          </label>
          <button className="btn-secondary" type="submit">
            Record result
          </button>
        </form>
      </div>

      <form method="post" action={action("regrade")} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="regrade" value="1" />
        <button className="btn" type="submit">
          Re-grade with harness results
        </button>
        <span className="muted">Re-runs the SWE Test 1 grader so S1–S4 use the latest results above (scores stay advisory).</span>
      </form>
    </section>
  );
}

export { HarnessPanel };
