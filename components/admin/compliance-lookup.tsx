"use client";
import { useActionState } from "react";
import type { LookupState } from "@/lib/server/retention";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-ZA", { year: "numeric", month: "short", day: "numeric" }) : "—");

/**
 * Dispute lookup on /admin/compliance: someone whose information was purged asks about a
 * decision. They give the e-mail address they applied with; the server computes its HMAC (the
 * pepper never leaves the server) and returns the archived decision log for it. No id or hash
 * is ever shown. The address is not stored or logged by this form.
 */
export function ArchiveLookupForm({ action }: { action: (prev: LookupState, formData: FormData) => Promise<LookupState> }) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as LookupState);
  return (
    <div className="space-y-3" data-testid="archive-lookup">
      <form action={formAction} className="flex flex-wrap items-end gap-3 text-sm">
        <label>
          <span className="label">E-mail address they applied with</span>
          <input name="email" type="email" required autoComplete="off" className="input w-72" />
        </label>
        <button className="btn-secondary" disabled={pending}>{pending ? "Looking…" : "Look up the archive"}</button>
      </form>
      {state.status === "error" && <p className="error">{state.message}</p>}
      {state.status === "found" &&
        (state.result.purges.length === 0 && state.result.decisions.length === 0 ? (
          <p className="muted">
            Nothing archived for {state.email}. If they still have an account, their full record is on their candidate page.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm">
              {state.email}:{" "}
              {state.result.purges.map((p) => `${p.scope === "candidate" ? "purged" : p.scope.replace("_", " ")} ${fmt(p.purged_at)}`).join("; ") ||
                "no purge logged"}
            </p>
            {state.result.decisions.length > 0 ? (
              <table className="table">
                <thead>
                  <tr><th>Decided</th><th>Role</th><th>Stage</th><th>Decision</th><th>Reason</th></tr>
                </thead>
                <tbody>
                  {state.result.decisions.map((d, i) => (
                    <tr key={`${d.decided_at}-${i}`}>
                      <td>{fmt(d.decided_at)}</td>
                      <td>{d.role_slug ?? "—"}</td>
                      <td>{d.stage ?? "—"}</td>
                      <td>{d.decision ?? "—"}</td>
                      <td>{d.reason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No decisions were recorded for them.</p>
            )}
          </div>
        ))}
    </div>
  );
}
