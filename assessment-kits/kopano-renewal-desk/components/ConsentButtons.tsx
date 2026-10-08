"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Records consent on a contact point (RD-05). Once a contact opts out, only a manager can lift it,
 * with a reason; the database enforces the same rule.
 */
export function ConsentButtons({ contactPointId, status, canLift }: { contactPointId: string; status: string; canLift: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lifting, setLifting] = useState(false);
  const [reason, setReason] = useState("");

  async function record(consentStatus: "opted_in" | "opted_out", liftReason?: string) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/contact-points/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactPointId, consentStatus, ...(liftReason ? { reason: liftReason } : {}) }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Not saved.");
      return;
    }
    setLifting(false);
    setReason("");
    router.refresh();
  }

  if (status === "opted_out") {
    if (!canLift) return <span className="muted text-xs">Opted out: only a manager can lift it</span>;
    if (!lifting)
      return (
        <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setLifting(true)} type="button">
          Lift opt-out
        </button>
      );
    return (
      <span className="inline-flex flex-col gap-1">
        <input className="input text-xs" maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Reason (recorded)" value={reason} />
        <span className="inline-flex gap-1">
          <button className="btn-secondary px-2 py-1 text-xs" disabled={busy || reason.trim().length < 5} onClick={() => record("opted_in", reason.trim())} type="button">
            Lift and mark opted in
          </button>
          <button className="btn-secondary px-2 py-1 text-xs" disabled={busy} onClick={() => setLifting(false)} type="button">
            Cancel
          </button>
        </span>
        {error && <span className="text-xs text-red-700">{error}</span>}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button className="btn-secondary px-2 py-1 text-xs" disabled={busy} onClick={() => record("opted_in")} type="button">
        Opted in
      </button>
      <button className="btn-secondary px-2 py-1 text-xs" disabled={busy} onClick={() => record("opted_out")} type="button">
        Opted out
      </button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
