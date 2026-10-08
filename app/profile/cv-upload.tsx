"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export default function CvUpload({ userId }: { userId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const type = TYPES[ext];
    if (!type) return setError("Please upload a PDF or .docx file.");
    if (file.size > MAX_BYTES) return setError("That file is over 5 MB.");

    setBusy(true);
    setStatus("Uploading…");
    const path = `${userId}/${Date.now()}.${ext}`;
    const { error: upErr } = await createClient()
      .storage.from("cvs")
      .upload(path, file, { contentType: type, upsert: false });
    if (upErr) {
      setBusy(false);
      setStatus(null);
      return setError(upErr.message);
    }

    setStatus("Reading your CV… this can take up to a minute.");
    const res = await fetch("/api/cv/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, fileName: file.name.slice(0, 200) }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    setStatus(null);
    if (!res.ok) setError(body.error ?? "Something went wrong reading your CV.");
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <input
        type="file"
        accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        onChange={onChange}
        disabled={busy}
        aria-label="Upload CV"
        className="block text-sm"
      />
      {status && <p className="notice">{status}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
