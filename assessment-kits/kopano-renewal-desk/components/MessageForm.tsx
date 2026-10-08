"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface TemplateOption {
  id: string;
  name: string;
  category: "utility" | "marketing";
  body: string;
}

export function MessageForm({ customerId, templates, blocked }: { customerId: string; templates: TemplateOption[]; blocked: string | null }) {
  const router = useRouter();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const template = templates.find((t) => t.id === templateId);

  async function queue() {
    setBusy(true);
    setResult(null);
    const res = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId, templateId }),
    });
    setBusy(false);
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: { channel?: string } };
    setResult(res.ok ? { ok: true, text: `Queued for ${body.message?.channel ?? "sending"}. The messaging platform sends it.` } : { ok: false, text: body.error ?? "The message could not be queued." });
    if (res.ok) router.refresh();
  }

  if (blocked) return <p className="notice">{blocked}</p>;
  if (!templates.length) return <p className="muted">No approved templates yet.</p>;
  return (
    <div className="space-y-3">
      <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} ({t.category})
          </option>
        ))}
      </select>
      {template && <p className="rounded-md bg-slate-50 p-3 text-sm whitespace-pre-wrap">{template.body}</p>}
      {result && <p className={result.ok ? "ok" : "error"}>{result.text}</p>}
      <button className="btn" disabled={busy || !templateId} onClick={queue} type="button">
        {busy ? "Queueing…" : "Queue message"}
      </button>
    </div>
  );
}
