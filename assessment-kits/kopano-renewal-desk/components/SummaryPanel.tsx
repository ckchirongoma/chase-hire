"use client";

import { useState } from "react";

export function SummaryPanel({ customerId }: { customerId: string }) {
  const [question, setQuestion] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId, question: question.trim() || undefined }),
    });
    setBusy(false);
    const body = (await res.json().catch(() => ({}))) as { summary?: string; error?: string };
    if (!res.ok || !body.summary) setError(body.error ?? "No summary this time.");
    else setSummary(body.summary);
  }

  return (
    <div className="space-y-3">
      <input className="input" maxLength={500} placeholder="Optional: what do you want to know before the call?" value={question} onChange={(e) => setQuestion(e.target.value)} />
      <button className="btn-secondary" disabled={busy} onClick={run} type="button">
        {busy ? "Thinking…" : "AI summary"}
      </button>
      {error && <p className="error">{error}</p>}
      {summary && <div className="rounded-md bg-slate-50 p-3 text-sm whitespace-pre-wrap">{summary}</div>}
      <p className="muted">AI output can be wrong. Check it against the record.</p>
    </div>
  );
}
