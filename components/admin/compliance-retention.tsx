import Link from "next/link";
import { fmtDate, STAGE_LABEL, STATUS_LABEL } from "@/lib/format";
import type { InProgressPurge, PurgeLogEntry, QueueEntry, StaleApplication } from "@/lib/server/compliance";
import type { PlannedPurge } from "@/lib/server/retention";

/**
 * Display pieces for the retention section of /admin/compliance (server components). Nothing
 * here shows a hashed id: a purged person is matched only through the e-mail lookup.
 */

const COUNT_LABEL: Record<string, string> = {
  decisions_archived: "decisions archived",
  reasoning_responses_archived: "reasoning answers archived",
  quiz_responses_archived: "quiz answers archived",
  grades_deleted: "grade samples deleted",
  grade_summaries_deleted: "grade summaries deleted",
  grading_jobs_deleted: "grading jobs deleted",
  auth_audit_rows_deleted: "auth log rows deleted",
};

function storageSummary(storage: unknown): string {
  if (!storage || typeof storage !== "object") return "no files";
  const parts = Object.entries(storage as Record<string, number>)
    .filter(([, n]) => Number(n) > 0)
    .map(([bucket, n]) => `${bucket} ${n}`);
  return parts.length ? parts.join(", ") : "no files";
}

export function RetentionQueueTable({ rows, today }: { rows: QueueEntry[]; today: string }) {
  if (!rows.length) return <p className="muted">Nobody is queued.</p>;
  return (
    <table className="table" data-testid="retention-queue">
      <thead>
        <tr><th>Candidate</th><th>Purge on</th><th>Why</th><th>Clock started</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.userId}>
            <td>{r.name}</td>
            <td>
              {r.purgeAfter} {r.purgeAfter <= today && <span className="badge-warn">due</span>}
            </td>
            <td>{r.reason}</td>
            <td>{fmtDate(r.basisAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DryRunTable({ rows, names }: { rows: PlannedPurge[]; names: Map<string, string> }) {
  if (!rows.length) return <p className="muted">Nobody is due: a purge now would do nothing.</p>;
  return (
    <table className="table" data-testid="dry-run">
      <thead>
        <tr><th>Candidate</th><th>Due since</th><th>Decisions to archive</th><th>Answers to archive</th><th>Grades to delete</th><th>Files to delete</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.userId}>
            <td>{names.get(r.userId) ?? r.userId.slice(0, 8)}<div className="muted">{r.reason}</div></td>
            <td>{r.purgeAfter}</td>
            <td>{r.decisions}</td>
            <td>{r.reasoningResponses} reasoning, {r.quizResponses} quiz</td>
            <td>{r.grades}</td>
            <td>{storageSummary(r.storage)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function InProgressTable({ rows }: { rows: InProgressPurge[] }) {
  if (!rows.length) return null;
  return (
    <div className="space-y-2">
      <h3 className="font-semibold">Purges in progress ({rows.length})</h3>
      <p className="muted">
        These stopped halfway (for example a storage error) and are picked up again on the next run, taking turns with the
        people newly due so they never hold them up. Until the account is deleted, every run re-checks the rules first and,
        if the person is no longer due, lifts the account suspension and undoes the purge; meanwhile their applications
        can&apos;t be re-opened. Files are deleted again on every run, so a late upload is caught. An error naming a table means
        a row keyed by the person survived the cascade: fix the cause, then run the purge again.
      </p>
      <table className="table" data-testid="purges-in-progress">
        <thead>
          <tr><th>Started</th><th>Step</th><th>Attempts</th><th>Last error</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.startedAt}-${i}`}>
              <td>{fmtDate(r.startedAt)}</td>
              <td>{r.step}</td>
              <td>{r.attempts}</td>
              <td className="text-red-700">{r.lastError ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PurgeLogTable({ rows }: { rows: PurgeLogEntry[] }) {
  if (!rows.length) return <p className="muted">No purges yet.</p>;
  return (
    <table className="table" data-testid="purge-log">
      <thead>
        <tr><th>When</th><th>Scope</th><th>What went</th><th>By</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const d = r.detail;
          const counts = Object.entries(COUNT_LABEL)
            .filter(([k]) => Number(d[k] ?? 0) > 0)
            .map(([k, label]) => `${Number(d[k])} ${label}`);
          const by = typeof d.triggered_by === "string" ? (d.triggered_by.startsWith("admin:") ? "admin" : d.triggered_by) : "—";
          if (r.scope === "cancelled") {
            return (
              <tr key={r.id}>
                <td>{fmtDate(r.purgedAt)}</td>
                <td>cancelled</td>
                <td className="muted">
                  No longer due ({String(d.reason ?? "")}): the archived decisions and held answers were removed; nothing was
                  deleted.
                </td>
                <td>—</td>
              </tr>
            );
          }
          if (r.scope === "late_upload") {
            return (
              <tr key={r.id}>
                <td>{fmtDate(r.purgedAt)}</td>
                <td>late upload</td>
                <td>Files that arrived after an earlier purge finished: {storageSummary(d.storage_objects_deleted)}</td>
                <td>{by}</td>
              </tr>
            );
          }
          return (
            <tr key={r.id}>
              <td>{fmtDate(r.purgedAt)}</td>
              <td>{r.scope}</td>
              <td>
                {[...counts, `files: ${storageSummary(d.storage_objects_deleted)}`].join("; ")}
                {typeof d.note === "string" && <div className="muted">{d.note}</div>}
              </td>
              <td>{by}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Idle applications still in play, with a form to close the ticked ones as lapsed (one written
 * reason for the batch; each application gets its own decision row, which the candidate sees).
 */
export function StaleApplicationsTable({ rows, action }: { rows: StaleApplication[]; action: (formData: FormData) => Promise<void> }) {
  if (!rows.length) return <p className="muted">None: every application in play has had activity in the last 3 months.</p>;
  return (
    <form action={action} className="space-y-3">
      <table className="table" data-testid="stale-applications">
        <thead>
          <tr><th>Close</th><th>Candidate</th><th>Role</th><th>Stage</th><th>Last activity</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.applicationId}>
              <td><input type="checkbox" name="application_id" value={r.applicationId} aria-label={`Close ${r.name}'s application`} /></td>
              <td><Link href={`/admin/candidates/${r.userId}`} className="underline">{r.name}</Link></td>
              <td>{r.role ?? "—"}{r.roundClosedAt && <div className="muted">round closed {fmtDate(r.roundClosedAt)}</div>}</td>
              <td>{STAGE_LABEL[r.stage] ?? r.stage} · {STATUS_LABEL[r.status] ?? r.status}</td>
              <td>{fmtDate(r.lastActivity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="min-w-[20rem] flex-1">
          <span className="label">Reason (at least 20 characters; the candidate sees it with the decision)</span>
          <input
            name="reason"
            required
            minLength={20}
            className="input w-full"
            placeholder="e.g. No response to the quiz invitation or our two follow-ups since June."
          />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="ack" required /> Close the ticked applications as lapsed
        </label>
        <button className="btn-secondary">Close as lapsed</button>
      </div>
    </form>
  );
}
