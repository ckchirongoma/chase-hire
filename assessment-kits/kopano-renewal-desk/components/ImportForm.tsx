"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface ImportResponse {
  error?: string;
  runId?: string;
  counts?: Record<string, unknown>;
  quarantine?: { row_number: number; reason: string; detail: string }[];
  message?: string;
}

const KINDS = [
  ["base", "Monthly base export"],
  ["optouts", "Legal opt-out list"],
  ["contacts", "Agent contact sheets"],
] as const;

export function ImportForm() {
  const router = useRouter();
  const [kind, setKind] = useState<string>("base");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; body: ImportResponse } | null>(null);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setResult(null);
    const form = new FormData();
    form.set("file", file);
    form.set("kind", kind);
    const res = await fetch("/api/import", { method: "POST", body: form });
    const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as ImportResponse;
    setBusy(false);
    setResult({ ok: res.ok, body });
    router.refresh();
  }

  return (
    <form onSubmit={upload} className="card space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="kind">
            File
          </label>
          <select className="input" id="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <input accept=".xlsx" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} type="file" />
        <button className="btn" disabled={busy || !file} type="submit">
          {busy ? "Importing…" : "Import"}
        </button>
      </div>
      {result && !result.ok && <p className="error">{result.body.error ?? "The import failed."}</p>}
      {result?.ok && (
        <div className="ok">
          {result.body.message ?? "Imported."}
          {result.body.counts && (
            <ul className="mt-2 grid grid-cols-2 gap-x-6 text-xs sm:grid-cols-3">
              {Object.entries(result.body.counts)
                .filter(([, v]) => typeof v === "number")
                .map(([k, v]) => (
                  <li key={k}>
                    {k.replace(/_/g, " ")}: {String(v)}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
