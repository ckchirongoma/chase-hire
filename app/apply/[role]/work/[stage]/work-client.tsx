"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/browser";
import { useIntegrity } from "@/lib/client/use-integrity";
import { fmtDate } from "@/lib/format";
import { parseSubmission } from "@/lib/work/schema";
import {
  AUTOSAVE_INTERVAL_MS,
  displayName,
  EXT_MIME,
  extOf,
  MAX_EXTRA_FILES,
  MAX_UPLOAD_BYTES,
  STAGE_FIELDS,
  uploadPath,
  WORK_GRACE_MS,
  type FieldDef,
  type FileField,
  type TextField,
} from "@/lib/work/stages";
import { countdown, humanDuration } from "@/lib/work/time";
import type { DatasetFile, WorkView } from "@/lib/work/types";
import PersonaChat from "./persona-chat";

type Tab = "work" | "client";
type Values = Record<string, string>;
type Files = Record<string, string[]>;

async function api<T>(path: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: (json as { error?: string }).error ?? "Something went wrong" };
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, status: 0, error: "Network error. Check your connection and try again." };
  }
}

function fromDraft(view: WorkView): { values: Values; files: Files } {
  const values: Values = {};
  const files: Files = {};
  const draft = view.attempt?.draft ?? {};
  for (const f of STAGE_FIELDS[view.stage.key]) {
    const v = draft[f.name];
    if (f.kind === "file") files[f.name] = Array.isArray(v) ? v : [];
    else values[f.name] = typeof v === "string" ? v : "";
  }
  return { values, files };
}

function sizeLabel(bytes: number | null) {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function WorkClient({ initial, userId, brief }: { initial: WorkView; userId: string; brief: ReactNode }) {
  const [view, setView] = useState(initial);
  const offset = useRef(new Date(initial.serverNow).getTime() - Date.now());
  const [now, setNow] = useState(() => new Date(initial.serverNow).getTime());
  const [tab, setTab] = useState<Tab>("work");
  const [confirmStart, setConfirmStart] = useState(false);
  const [busy, setBusy] = useState<"start" | "submit" | "upload" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((v: WorkView) => {
    offset.current = new Date(v.serverNow).getTime() - Date.now();
    setView(v);
  }, []);

  useEffect(() => {
    setNow(Date.now() + offset.current);
    const id = setInterval(() => setNow(Date.now() + offset.current), 1000);
    return () => clearInterval(id);
  }, []);

  const attempt = view.attempt;
  const attemptId = attempt?.id ?? null;
  const key = view.stage.key;
  const active = view.status === "active";
  const deadline = attempt?.deadlineAt ? new Date(attempt.deadlineAt).getTime() : null;
  const pastDeadline = deadline !== null && now > deadline;

  // Integrity signals while the work window runs (blur/focus only; paste is allowed in the work
  // form, since candidates paste links and the Loom transcript). The chat blocks paste itself.
  useIntegrity(`work:${key}`, { active: active && tab === "work" });

  const refresh = useCallback(async () => {
    if (!attemptId) return;
    const res = await api<WorkView>(`/api/work/${attemptId}/state`);
    if (res.ok) apply(res.data);
  }, [attemptId, apply]);

  // When the deadline (+ the server's grace) passes, ask the server what happened.
  const refreshedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!active || deadline === null || !attempt) return;
    if (now > deadline + WORK_GRACE_MS + 500 && refreshedFor.current !== attempt.id) {
      refreshedFor.current = attempt.id;
      void refresh();
    }
  }, [now, active, deadline, attempt, refresh]);

  // ───────── Start ─────────
  const start = async () => {
    if (!attemptId) return;
    setBusy("start");
    setError(null);
    const res = await api<WorkView>(`/api/work/${attemptId}/start`, {});
    setBusy(null);
    setConfirmStart(false);
    if (res.ok) apply(res.data);
    else setError(res.error);
  };

  if (view.status === "ready" && attempt) {
    const openLeft = new Date(attempt.openUntil).getTime() - now;
    const windowText = view.stage.workWindowMs ? humanDuration(view.stage.workWindowMs) : null;
    return (
      <div className="space-y-4">
        <section className="card space-y-3">
          <h2 className="h2">The brief</h2>
          {brief}
        </section>
        <section className="card space-y-3 text-sm">
          <p>
            Press Start when you are ready. You have until <strong>{fmtDate(attempt.openUntil)}</strong> to start (
            <span className="font-mono">{countdown(openLeft)}</span> left).
          </p>
          {!confirmStart ? (
            <button className="btn" onClick={() => setConfirmStart(true)} disabled={openLeft <= 0}>
              Start the assessment
            </button>
          ) : (
            <div className="space-y-3 rounded-md border border-slate-300 bg-slate-50 p-4" role="alertdialog" aria-label="Confirm start">
              <p>
                Your {windowText ? `${windowText} ` : ""}work window starts now and can&apos;t be paused or restarted. The
                files and {view.stage.hasPersona ? "the client chat " : ""}open when you start. Start now?
              </p>
              <div className="flex gap-3">
                <button className="btn" onClick={() => void start()} disabled={busy === "start"}>
                  {busy === "start" ? "Starting…" : "Yes, start now"}
                </button>
                <button className="btn-secondary" onClick={() => setConfirmStart(false)} disabled={busy === "start"}>
                  Not yet
                </button>
              </div>
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </section>
      </div>
    );
  }

  if (view.status === "submitted") return <Submitted view={view} brief={brief} />;

  if (view.status !== "active" || !attempt || !attemptId) {
    return (
      <div className="space-y-3">
        <p className="notice">{view.notice ?? "This assessment isn't available right now."}</p>
        <Link href="/me/results" className="btn-secondary">
          My application
        </Link>
      </div>
    );
  }

  const left = deadline === null ? 0 : deadline - now;
  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <span className="text-sm">
          Deadline <strong>{fmtDate(attempt.deadlineAt)}</strong>
        </span>
        <span className={`font-mono text-lg ${left < 15 * 60_000 ? "text-red-600" : ""}`} aria-label="Time remaining">
          {pastDeadline ? "Time is up" : countdown(left)}
        </span>
      </div>

      {view.stage.hasPersona && (
        <div className="flex gap-2" role="tablist">
          <button role="tab" aria-selected={tab === "work"} className={tab === "work" ? "btn" : "btn-secondary"} onClick={() => setTab("work")}>
            Brief and submission
          </button>
          <button role="tab" aria-selected={tab === "client"} className={tab === "client" ? "btn" : "btn-secondary"} onClick={() => setTab("client")}>
            Interview the client
          </button>
        </div>
      )}

      <div hidden={tab !== "work"} className="space-y-4">
        <section className="card space-y-3">
          <h2 className="h2">The brief</h2>
          {brief}
        </section>
        {view.stage.materials.templateCopyUrl && <Materials materials={view.stage.materials} />}
        {view.stage.hasDatasets && <Downloads attemptId={attemptId} />}
        <SubmissionForm view={view} userId={userId} attemptId={attemptId} pastDeadline={pastDeadline} onSubmitted={apply} busy={busy} setBusy={setBusy} />
      </div>

      {view.stage.hasPersona && (
        <div hidden={tab !== "client"}>
          <PersonaChat attemptId={attemptId} visible={tab === "client"} />
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Downloads ─────────────────────────

function Downloads({ attemptId }: { attemptId: string }) {
  const [files, setFiles] = useState<DatasetFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await api<{ files: DatasetFile[] }>(`/api/work/${attemptId}/datasets`);
    setLoading(false);
    if (res.ok) setFiles(res.data.files);
    else setError(res.error);
  }, [attemptId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="card space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="h2 mb-0">Downloads</h2>
        <button className="btn-secondary" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh links"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {files && files.length === 0 && <p className="muted">There are no files for this assessment yet. Refresh in a minute, or tell us if this persists.</p>}
      {files && files.length > 0 && (
        <>
          <ul className="space-y-1">
            {files.map((f) => (
              <li key={f.name} className="flex items-center justify-between gap-3">
                <a href={f.url} className="font-medium underline" rel="noopener noreferrer">
                  {f.name}
                </a>
                <span className="muted">{sizeLabel(f.size)}</span>
              </li>
            ))}
          </ul>
          <p className="muted">Links expire after 10 minutes. Press “Refresh links” for fresh ones. All data is synthetic.</p>
        </>
      )}
    </section>
  );
}

// ───────────────────────── Submission form ─────────────────────────

function SubmissionForm({
  view,
  userId,
  attemptId,
  pastDeadline,
  onSubmitted,
  busy,
  setBusy,
}: {
  view: WorkView;
  userId: string;
  attemptId: string;
  pastDeadline: boolean;
  onSubmitted: (v: WorkView) => void;
  busy: "start" | "submit" | "upload" | null;
  setBusy: (b: "start" | "submit" | "upload" | null) => void;
}) {
  const fields = STAGE_FIELDS[view.stage.key];
  const initialForm = useMemo(() => fromDraft(view), [view]);
  const [values, setValues] = useState<Values>(initialForm.values);
  const [files, setFiles] = useState<Files>(initialForm.files);
  const [savedAt, setSavedAt] = useState<string | null>(view.attempt?.draftSavedAt ?? null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const dirty = useRef(false);
  const latest = useRef({ values, files });
  latest.current = { values, files };

  const draftPayload = useCallback(() => {
    const d: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(latest.current.values)) if (v) d[k] = v;
    for (const [k, v] of Object.entries(latest.current.files)) if (v.length) d[k] = v;
    return d;
  }, []);

  const save = useCallback(async () => {
    if (!dirty.current) return;
    dirty.current = false;
    const res = await api<{ savedAt: string }>(`/api/work/${attemptId}/draft`, { draft: draftPayload() });
    if (res.ok) {
      setSavedAt(res.data.savedAt);
      setSaveError(null);
    } else {
      dirty.current = res.status === 0 || res.status >= 500; // retry on network/server errors only
      setSaveError(res.error);
    }
  }, [attemptId, draftPayload]);

  useEffect(() => {
    if (pastDeadline) return;
    const id = setInterval(() => void save(), AUTOSAVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [save, pastDeadline]);

  const setValue = (name: string, v: string) => {
    dirty.current = true;
    setValues((prev) => ({ ...prev, [name]: v }));
  };

  const upload = async (field: FileField, list: FileList | null) => {
    if (!list?.length) return;
    setError(null);
    setBusy("upload");
    const supabase = createClient(); // browser-only: the candidate's own session, RLS on their folder
    try {
      for (const file of Array.from(list)) {
        const ext = extOf(file.name);
        if (!ext || !field.exts.includes(ext)) {
          setError(`${file.name}: ${field.label} must be ${field.exts.map((e) => e.toUpperCase()).join(", ")}.`);
          continue;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          setError(`${file.name} is larger than 20 MB.`);
          continue;
        }
        if (field.multiple && (latest.current.files[field.name]?.length ?? 0) >= MAX_EXTRA_FILES) {
          setError(`You can add up to ${MAX_EXTRA_FILES} extra files.`);
          break;
        }
        const path = uploadPath(userId, attemptId, file.name);
        const { error: upErr } = await supabase.storage.from("submissions").upload(path, file, { contentType: EXT_MIME[ext], upsert: false });
        if (upErr) {
          setError(`Could not upload ${file.name}: ${upErr.message}`);
          continue;
        }
        dirty.current = true;
        setFiles((prev) => {
          const next = { ...prev, [field.name]: field.multiple ? [...(prev[field.name] ?? []), path] : [path] };
          latest.current = { ...latest.current, files: next };
          return next;
        });
      }
    } finally {
      setBusy(null);
      void save();
    }
  };

  const removeFile = (field: FileField, path: string) => {
    dirty.current = true;
    setFiles((prev) => ({ ...prev, [field.name]: (prev[field.name] ?? []).filter((p) => p !== path) }));
  };

  const body = () => {
    const b: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.kind === "file") b[f.name] = f.multiple ? (files[f.name] ?? []) : (files[f.name]?.[0] ?? "");
      else b[f.name] = values[f.name] ?? "";
    }
    return b;
  };

  const check = () => {
    const res = parseSubmission(view.stage.key, body());
    return res.ok ? null : res.error;
  };

  const submit = async () => {
    setConfirm(false);
    setError(null);
    setBusy("submit");
    await save();
    const res = await api<WorkView>(`/api/work/${attemptId}/submit`, body());
    setBusy(null);
    if (res.ok) onSubmitted(res.data);
    else setError(res.error);
  };

  const disabled = pastDeadline || busy === "submit";
  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="h2 mb-0">Your submission</h2>
        <span className="muted" aria-live="polite">
          {saveError ? <span className="text-red-700">Autosave failed: {saveError}</span> : savedAt ? `Draft saved ${fmtDate(savedAt)}` : "Drafts save every 20 seconds"}
        </span>
      </div>

      {fields.map((f) => (
        <FieldInput key={f.name} field={f} value={values[f.name] ?? ""} files={files[f.name] ?? []} disabled={disabled} onChange={setValue} onUpload={upload} onRemove={removeFile} uploading={busy === "upload"} />
      ))}

      {pastDeadline ? (
        <p className="notice">The deadline has passed, so this can no longer be submitted.</p>
      ) : !confirm ? (
        <button
          className="btn"
          disabled={disabled || busy === "upload"}
          onClick={() => {
            const problem = check();
            if (problem) setError(problem);
            else setConfirm(true);
          }}
        >
          Submit
        </button>
      ) : (
        <div className="space-y-3 rounded-md border border-slate-300 bg-slate-50 p-4 text-sm" role="alertdialog" aria-label="Confirm submission">
          <p>Submit now? You can&apos;t change your submission afterwards. We record your links as they are at this moment.</p>
          <div className="flex gap-3">
            <button className="btn" onClick={() => void submit()} disabled={busy === "submit"}>
              {busy === "submit" ? "Submitting…" : "Yes, submit"}
            </button>
            <button className="btn-secondary" onClick={() => setConfirm(false)} disabled={busy === "submit"}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {busy === "submit" && <p className="muted">Checking your files and recording your submission…</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function FieldInput({
  field,
  value,
  files,
  disabled,
  uploading,
  onChange,
  onUpload,
  onRemove,
}: {
  field: FieldDef;
  value: string;
  files: string[];
  disabled: boolean;
  uploading: boolean;
  onChange: (name: string, v: string) => void;
  onUpload: (field: FileField, list: FileList | null) => void;
  onRemove: (field: FileField, path: string) => void;
}) {
  const id = `field-${field.name}`;
  if (field.kind === "file") {
    return (
      <div className="space-y-1">
        <label htmlFor={id} className="label">
          {field.label}
        </label>
        {field.help && <p className="muted">{field.help}</p>}
        {files.length > 0 && (
          <ul className="space-y-1 text-sm">
            {files.map((p) => (
              <li key={p} className="flex items-center gap-2">
                <span className="badge">{displayName(p)}</span>
                {!disabled && (
                  <button type="button" className="text-xs text-slate-500 underline" onClick={() => onRemove(field, p)}>
                    remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <input
          id={id}
          type="file"
          className="block text-sm"
          accept={field.exts.map((e) => `.${e}`).join(",")}
          multiple={!!field.multiple}
          disabled={disabled || uploading}
          onChange={(e) => {
            onUpload(field, e.target.files);
            e.target.value = "";
          }}
        />
        {!field.multiple && files.length > 0 && <p className="muted">Choosing another file replaces this one.</p>}
      </div>
    );
  }
  const text = field as TextField;
  const multiline = text.kind === "transcript" || text.kind === "text";
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="label">
        {text.label}
      </label>
      {text.help && <p className="muted">{text.help}</p>}
      {multiline ? (
        <textarea
          id={id}
          className={`input ${text.kind === "transcript" ? "min-h-48" : "min-h-24"}`}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(text.name, e.target.value)}
          spellCheck={text.kind !== "text"}
          autoComplete="off"
        />
      ) : (
        <input
          id={id}
          type="url"
          inputMode="url"
          className="input"
          value={value}
          disabled={disabled}
          placeholder={text.placeholder}
          onChange={(e) => onChange(text.name, e.target.value)}
          autoComplete="off"
        />
      )}
    </div>
  );
}

// ───────────────────────── Google Doc materials ─────────────────────────

function Materials({ materials }: { materials: WorkView["stage"]["materials"] }) {
  return (
    <section className="card space-y-3" data-testid="materials">
      <h2 className="h2">Your answer document</h2>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        {materials.instructionsUrl && (
          <li>
            Read the instructions:{" "}
            <a href={materials.instructionsUrl} target="_blank" rel="noopener noreferrer" className="underline">
              open the instructions (Google Doc)
            </a>
            .
          </li>
        )}
        <li>
          Make your own copy of the answer template and write in it. Only your copy is assessed.
          <div className="mt-2">
            <a href={materials.templateCopyUrl!} target="_blank" rel="noopener noreferrer" className="btn">
              Make a copy of the template
            </a>
          </div>
        </li>
        <li>Replace the grey guidance text as you go, and keep the template&apos;s first line.</li>
        <li>
          When you&apos;re done: in Google Docs press <strong>Share</strong>, set General access to{" "}
          <strong>Anyone with the link</strong> (Viewer), copy the link and paste it below. We save a copy of your document
          when you submit; later edits aren&apos;t assessed.
        </li>
      </ol>
    </section>
  );
}

// ───────────────────────── Submitted ─────────────────────────

function Submitted({ view, brief }: { view: WorkView; brief: ReactNode }) {
  const s = view.submission;
  return (
    <div className="space-y-4">
      <section className="card space-y-3 text-sm">
        <h2 className="h2">Submitted. Take a break.</h2>
        <p>
          We received your submission{s ? ` on ${fmtDate(s.submittedAt)}` : ""}. Grading is in progress; people on our team review every result and make every
          decision. Your scores appear on your application page once grading has finished, and someone will get back to you
          by email about the next step. Nothing else starts until you choose to start it.
        </p>
        {s && (
          <ul className="list-disc space-y-1 pl-5">
            {s.files.map((f) => (
              <li key={f.name}>{f.name}</li>
            ))}
            {s.links.map((l) => (
              <li key={l.name}>
                {l.name}: <span className="break-all">{l.url}</span>
              </li>
            ))}
            {s.wordCount !== null && view.stage.key === "ba_part1" && <li>Memo body: {s.wordCount.toLocaleString("en-US")} words</li>}
            {s.pageCount !== null && view.stage.key === "swe_test2" && <li>Memo: {s.pageCount} pages</li>}
          </ul>
        )}
        <Link href="/me/results" className="btn">
          My application
        </Link>
      </section>
      <details className="card text-sm">
        <summary className="cursor-pointer font-medium">The brief</summary>
        <div className="mt-3">{brief}</div>
      </details>
    </div>
  );
}
