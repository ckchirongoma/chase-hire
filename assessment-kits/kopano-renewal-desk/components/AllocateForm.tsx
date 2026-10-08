"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function AllocateForm({ customerId, agents }: { customerId: string; agents: { id: string; name: string }[] }) {
  const router = useRouter();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function allocate() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/allocations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId, agentId }),
    });
    setBusy(false);
    if (!res.ok) setError("Not saved.");
    else router.refresh();
  }

  if (!agents.length) return <span className="muted">No agents</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <select className="input w-40 py-1" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <button className="btn-secondary px-2 py-1 text-xs" disabled={busy} onClick={allocate} type="button">
        Allocate
      </button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
