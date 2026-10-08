import { fmtDate } from "@/lib/format";
import type { InProgressPurge, PurgeLogEntry, QueueEntry } from "@/lib/server/compliance";
import type { PlannedPurge } from "@/lib/server/retention";

/** Display pieces for the retention section of /admin/compliance (server components). */

const short = (hash: string) => `${hash.slice(0, 12)}…`;

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
        These stopped halfway (for example a storage error) and are finished first on the next run. An error naming a table
        means a row keyed by the person survived the cascade: fix the cause, then run the purge again.
      </p>
      <table className="table" data-testid="purges-in-progress">
        <thead>
          <tr><th>Hashed id</th><th>Started</th><th>Step</th><th>Attempts</th><th>Last error</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.userId}>
              <td className="font-mono text-xs">{short(r.hash)}</td>
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
        <tr><th>Purged</th><th>Hashed id</th><th>Scope</th><th>What went</th><th>By</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const d = r.detail;
          const counts = Object.entries(COUNT_LABEL)
            .filter(([k]) => Number(d[k] ?? 0) > 0)
            .map(([k, label]) => `${Number(d[k])} ${label}`);
          const by = typeof d.triggered_by === "string" ? (d.triggered_by.startsWith("admin:") ? "admin" : d.triggered_by) : "—";
          return (
            <tr key={r.id}>
              <td>{fmtDate(r.purgedAt)}</td>
              <td className="font-mono text-xs">{short(r.hash)}</td>
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
