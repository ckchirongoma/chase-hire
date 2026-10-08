"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Calls POST /api/admin/baseline for one rubric version, then refreshes the list. */
export default function GenerateBaselineButton({ rubricKey, version, hasBaseline }: { rubricKey: string; version: number; hasBaseline: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    if (hasBaseline && !window.confirm("Replace the existing baseline? Re-run the gold set afterwards.")) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/baseline", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rubricKey, version }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setMessage(body.error ?? `Failed (${res.status})`);
      else {
        setMessage(`Generated (${body.words} words, ${body.promptVersion})`);
        router.refresh();
      }
    } catch {
      setMessage("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <button type="button" className="btn-secondary" onClick={run} disabled={busy}>
        {busy ? "Generating…" : hasBaseline ? "Regenerate baseline" : "Generate baseline"}
      </button>
      {message && <p className="muted">{message}</p>}
    </div>
  );
}
