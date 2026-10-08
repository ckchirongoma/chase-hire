"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const OPTIONS = [
  ["call_back", "Call back"],
  ["quote", "Quote requested"],
  ["sale", "Sale"],
  ["not_interested", "Not interested"],
  ["no_answer", "No answer"],
] as const;

export function OutcomeForm({ customerId }: { customerId: string }) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<string>("call_back");
  const [when, setWhen] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (outcome === "call_back" && !when) {
      setError("Pick a callback date and time.");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/outcomes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId, outcome, nextActionAt: when ? new Date(when).toISOString() : null, notes: notes || null }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; fields?: Record<string, string> };
      setError(Object.values(body.fields ?? {})[0] ?? body.error ?? "The outcome could not be saved.");
      return;
    }
    setSaved(true);
    setNotes("");
    setWhen("");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="label" htmlFor="outcome">
          Outcome
        </label>
        <select className="input" id="outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          {OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="when">
          Next action {outcome === "call_back" ? "(required)" : "(optional)"}
        </label>
        <input className="input" id="when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required={outcome === "call_back"} />
      </div>
      <div>
        <label className="label" htmlFor="notes">
          Notes
        </label>
        <textarea className="input" id="notes" rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}
      {saved && <p className="ok">Saved.</p>}
      <button className="btn" disabled={busy} type="submit">
        {busy ? "Saving…" : "Log outcome"}
      </button>
    </form>
  );
}
