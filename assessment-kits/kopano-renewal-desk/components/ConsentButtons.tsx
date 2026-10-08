"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ConsentButtons({ contactPointId }: { contactPointId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function record(consentStatus: "opted_in" | "opted_out") {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/contact-points/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactPointId, consentStatus }),
    });
    setBusy(false);
    if (!res.ok) setError("Not saved.");
    else router.refresh();
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
