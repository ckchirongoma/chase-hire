"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { logSignal } from "@/lib/client/signals";
import { quizClock } from "@/lib/quiz/clock";
import { useTabRule } from "@/lib/client/use-tab-rule";
import { LockedNotice, TabPauseOverlay } from "@/components/integrity/tab-rule";

type Stem = { prompt: string; table?: { columns: string[]; rows: (string | number)[][] }; footnote?: string };
type State =
  | { status: "none" }
  | { status: "active"; attemptId: string; deadlineAt: string; serverNow: string; item: { position: number; total: number; stem: Stem; options: string[] } }
  | { status: "done"; attemptId: string; result: { rawScore: number; percentile: number; stars: number } }
  | { status: "locked"; attemptId: string };

export default function Runner({ resume }: { resume: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<State | null>(null);
  const [choice, setChoice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number>(0);
  const offset = useRef(0); // server clock minus client clock
  const lastExpiryCheck = useRef<number | null>(null);

  const apply = useCallback((s: State) => {
    setState(s);
    setChoice(null);
    if (s.status === "active") offset.current = new Date(s.serverNow).getTime() - Date.now();
    if (s.status === "done") router.refresh();
  }, [router]);

  const call = useCallback(async (url: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Something went wrong");
      apply(json as State);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }, [apply]);

  useEffect(() => {
    if (resume) call("/api/reasoning/state");
  }, [resume, call]);

  const refresh = useCallback(() => void call("/api/reasoning/state"), [call]);
  const tab = useTabRule({
    kind: "reasoning",
    id: state?.status === "active" ? state.attemptId : null,
    active: state?.status === "active",
    onLocked: refresh,
  });

  // Display-only countdown; the server enforces the deadline.
  useEffect(() => {
    if (state?.status !== "active") return;
    const deadline = new Date(state.deadlineAt).getTime();
    const tick = () => {
      // Same grace rules as the quiz: ask for the result once the server's grace has passed,
      // and keep asking every few seconds until it reports the attempt as done.
      const now = Date.now() + offset.current;
      const clock = quizClock(deadline, now, lastExpiryCheck.current);
      setRemaining(clock.remainingMs);
      if (clock.expiryCheckDue) {
        lastExpiryCheck.current = now;
        call("/api/reasoning/state");
      }
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [state, call]);

  // Integrity signals: tab switches and copy attempts (logged only).
  useEffect(() => {
    if (state?.status !== "active") return;
    const onVis = () => logSignal("reasoning", document.hidden ? "blur" : "focus", { position: state.item.position });
    const onCopy = (e: ClipboardEvent) => {
      e.preventDefault();
      logSignal("reasoning", "copy_attempt", { position: state.item.position });
    };
    document.addEventListener("visibilitychange", onVis);
    document.addEventListener("copy", onCopy);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener("copy", onCopy);
    };
  }, [state]);

  const submit = useCallback((answer: number | null) => {
    if (state?.status !== "active" || busy) return;
    call("/api/reasoning/next", { attemptId: state.attemptId, position: state.item.position, answer });
  }, [state, busy, call]);

  useEffect(() => {
    if (state?.status !== "active") return;
    const onKey = (e: KeyboardEvent) => {
      if (tab.paused) return;
      if (e.key >= "1" && e.key <= "5") setChoice(Number(e.key) - 1);
      else if (e.key === "Enter" && choice !== null) submit(choice);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, choice, submit, tab.paused]);

  if (!state || state.status === "none") {
    return (
      <div className="space-y-2">
        {error && <p className="error">{error}</p>}
        <button className="btn" disabled={busy || resume} onClick={() => call("/api/reasoning/start", {})}>
          {busy || resume ? "Loading…" : "Start the 15-minute assessment"}
        </button>
      </div>
    );
  }

  if (state.status === "done") {
    return <p className="notice">Finished. Loading your result…</p>;
  }

  if (state.status === "locked" || tab.locked) {
    return <LockedNotice />;
  }

  const { item } = state;
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000).toString().padStart(2, "0");

  return (
    <div className="card space-y-4 select-none" onContextMenu={(e) => e.preventDefault()}>
      <TabPauseOverlay open={tab.paused} onContinue={tab.resume} />
      <div className="flex items-center justify-between text-sm">
        <span>
          Question {item.position} of {item.total}
        </span>
        <span className={`font-mono text-lg ${remaining < 60000 ? "text-red-600" : ""}`} aria-label="Time remaining">
          {mins}:{secs}
        </span>
      </div>
      <div className="h-1 w-full rounded bg-slate-100">
        <div className="h-1 rounded bg-slate-900" style={{ width: `${((item.position - 1) / item.total) * 100}%` }} />
      </div>

      <p className="whitespace-pre-line text-lg" data-testid="stem">{item.stem.prompt}</p>
      {item.stem.table && (
        <table className="table w-auto">
          <thead>
            <tr>{item.stem.table.columns.map((c) => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {item.stem.table.rows.map((r, i) => (
              <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
            ))}
          </tbody>
        </table>
      )}
      {item.stem.footnote && <p className="muted">{item.stem.footnote}</p>}

      <div className="grid gap-2">
        {item.options.map((opt, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setChoice(i)}
            className={`rounded-md border px-3 py-2 text-left ${choice === i ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white hover:bg-slate-50"}`}
          >
            <span className="mr-2 font-mono">{i + 1}.</span>
            {opt}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}
      <div className="flex gap-3">
        <button className="btn" disabled={choice === null || busy} onClick={() => submit(choice)}>
          Confirm answer
        </button>
        <button className="btn-secondary" disabled={busy} onClick={() => submit(null)}>
          Skip
        </button>
      </div>
    </div>
  );
}
