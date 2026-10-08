"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { burstGuard, useIntegrity } from "@/lib/client/use-integrity";
import { useTabRule } from "@/lib/client/use-tab-rule";
import { LockedNotice, TabPauseOverlay } from "@/components/integrity/tab-rule";
import type { InterviewView } from "@/lib/interview/types";
import { VoiceRecorder, type Recording } from "./voice-recorder";

const CONTEXT = "interview";
const MAX_CHARS = 4000;

export default function InterviewChat({ applicationId, roleSlug, resume }: { applicationId: string; roleSlug: string; resume: boolean }) {
  const [state, setState] = useState<InterviewView | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the last answer arrived after the deadline and was not stored. */
  const [lateAnswer, setLateAnswer] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const offset = useRef(0); // server clock minus client clock
  const expiredFor = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const guard = useMemo(() => burstGuard(CONTEXT), []);
  const base = `/api/interview/${applicationId}`;

  const active = state?.status === "active";
  const typed = state?.status === "active" && state.answerMode === "typed";
  useIntegrity(CONTEXT, { active, blockPaste: typed });

  const apply = useCallback((s: InterviewView) => {
    if (s.status !== "none") offset.current = new Date(s.serverNow).getTime() - Date.now();
    setState(s);
  }, []);

  /** Returns the new state, or null on error. A 409 carries the current state: show it, keep the draft. */
  const call = useCallback(
    async (path: string, body?: unknown, quiet = false): Promise<InterviewView | null> => {
      if (!quiet) setBusy(true);
      if (!quiet) setError(null);
      try {
        const res = await fetch(`${base}/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const json = await res.json();
        if (res.status === 409 && json.state) {
          apply(json.state as InterviewView);
          setError(json.error ?? "The conversation has been refreshed.");
          return null;
        }
        if (!res.ok) throw new Error(json.error ?? "Something went wrong");
        apply(json as InterviewView);
        return json as InterviewView;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
        return null;
      } finally {
        if (!quiet) setBusy(false);
      }
    },
    [base, apply],
  );

  useEffect(() => {
    if (resume) call("state");
  }, [resume, call]);

  const refresh = useCallback(() => void call("state", undefined, true), [call]);
  const tab = useTabRule({
    kind: "interview",
    id: state?.status === "active" ? state.sessionId : null,
    active: state?.status === "active" && !state.done && !state.locked,
    onLocked: refresh,
  });

  // Display-only countdown; the server enforces the deadline.
  useEffect(() => {
    if (state?.status !== "active") return;
    const deadline = new Date(state.deadlineAt).getTime();
    const tick = () => {
      const left = deadline - (Date.now() + offset.current);
      setRemaining(Math.max(0, left));
      if (left <= -1000 && expiredFor.current !== state.sessionId) {
        expiredFor.current = state.sessionId;
        setTimeout(() => call("state"), 5500); // after the server's 5 s grace
      }
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [state, call]);

  // An answer is stored but the next question is still being prepared (e.g. a second tab): poll.
  const pending = state?.status === "active" && state.pending;
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => void call("state", undefined, true), 2000);
    return () => clearInterval(id);
  }, [pending, call]);

  const count = state && state.status !== "none" ? state.messages.length : 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [count]);

  /** A spoken answer: multipart upload, then the server transcribes it and asks the next question. */
  const sendVoice = useCallback(
    async (r: Recording): Promise<boolean> => {
      if (busy || state?.status !== "active" || state.pending || state.notice) return false;
      setBusy(true);
      setError(null);
      try {
        const form = new FormData();
        form.append("audio", new File([r.blob], `answer.${r.mime.includes("mp4") ? "m4a" : r.mime.split("/")[1] ?? "webm"}`, { type: r.mime }));
        form.append("turn", String(state.turn));
        form.append("durationMs", String(Math.round(r.durationMs)));
        const res = await fetch(`${base}/answer`, { method: "POST", body: form });
        const json = await res.json();
        if (res.status === 409 && json.state) {
          apply(json.state as InterviewView);
          setError(json.error ?? "The conversation has been refreshed.");
          return false;
        }
        if (!res.ok) throw new Error(json.error ?? "Something went wrong");
        const next = json as InterviewView;
        apply(next);
        if (next.status !== "none" && next.lastAnswer === "late") setLateAnswer(true);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, state, base, apply],
  );

  const readAloud = useCallback((text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-ZA";
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  }, []);

  const send = useCallback(async () => {
    const content = text.trim();
    if (!content || busy || state?.status !== "active" || state.pending || state.notice) return;
    // The turn token says which question this answers; the server refuses a stale one with 409.
    const next = await call("message", { content, turn: state.turn });
    if (!next || next.status === "none") return;
    if (next.lastAnswer === "saved") setText("");
    else if (next.lastAnswer === "late") setLateAnswer(true);
  }, [text, busy, state, call]);

  if (!state || state.status === "none") {
    return (
      <div className="space-y-2">
        {error && <p className="error">{error}</p>}
        <button className="btn" disabled={busy || (resume && !error)} onClick={() => call("start", {})}>
          {busy || (resume && !error) ? "Loading…" : "Start the interview"}
        </button>
      </div>
    );
  }

  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000)
    .toString()
    .padStart(2, "0");
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  if (state.locked || tab.locked) {
    return <LockedNotice />;
  }

  return (
    <div className="space-y-4">
      <TabPauseOverlay open={tab.paused} onContinue={tab.resume} />
      <div className="card space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="muted">{state.done ? "Interview finished" : state.current?.label}</span>
          {!state.done && (
            <span className={`font-mono text-lg ${remaining < 120000 ? "text-red-600" : ""}`} aria-label="Time remaining">
              {mins}:{secs}
            </span>
          )}
        </div>
        <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1" data-testid="transcript">
          {state.messages.map((m) => (
            <div key={m.id} className={m.role === "candidate" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={`max-w-[85%] whitespace-pre-line rounded-lg px-3 py-2 text-sm ${
                  m.role === "candidate" ? "bg-slate-900 text-white" : "border border-slate-200 bg-slate-50"
                }`}
              >
                {m.label && <p className="mb-1 text-xs font-medium text-slate-500">{m.label}</p>}
                {m.content}
              </div>
            </div>
          ))}
          <div ref={bottom} />
        </div>
      </div>

      {state.done ? (
        <div className="card space-y-3 text-sm">
          <p>
            {state.endReason !== "timeout"
              ? "Thank you, the interview is complete and your answers have been saved."
              : lateAnswer
                ? "Time ran out before your last answer reached us, so that answer was not saved. Your earlier answers were saved."
                : "Time ran out, so the interview ended. Every answer that reached us before the deadline has been saved."}{" "}
            People on our team review the results; nothing is decided automatically. Your scores appear on your results page once grading has finished.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href={`/apply/${roleSlug}/quiz`} className="btn">Go to the role quiz</Link>
            <Link href="/me/results" className="btn-secondary">My results</Link>
          </div>
        </div>
      ) : state.notice ? (
        <p className="notice">{state.notice}</p>
      ) : (
        <div className="card space-y-2">
          {(state.pending || (busy && !typed)) && (
            <p className="notice">Your answer is saved. {typed ? "" : "Transcribing it and "}preparing the next question…</p>
          )}
          {state.current && (
            <div className="rounded-md bg-slate-50 p-3 text-sm" data-testid="current-question">
              <div className="mb-1 flex items-center justify-between">
                <p className="text-xs font-medium text-slate-500">{state.current.label}</p>
                <button type="button" className="text-xs underline" onClick={() => readAloud(state.current!.text)}>
                  Read aloud
                </button>
              </div>
              <p className="whitespace-pre-line">{state.current.text}</p>
            </div>
          )}
          {!typed ? (
            <>
              <VoiceRecorder disabled={state.pending || !!state.notice} sending={busy} onSend={sendVoice} />
              <p className="muted">
                Answer out loud, up to 3 minutes. You can listen back and record again before you send. We transcribe your
                answer; we never judge your accent or how you sound.
              </p>
              {error && <p className="error">{error}</p>}
            </>
          ) : (
          <>
          <label htmlFor="answer" className="label">Your answer</label>
          <textarea
            id="answer"
            className="input min-h-36"
            value={text}
            maxLength={MAX_CHARS}
            disabled={busy || state.pending}
            onKeyDown={(e) => {
              guard.onKeyDown();
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void send();
              }
            }}
            onChange={(e) => {
              guard.track(e.target.value);
              setText(e.target.value);
            }}
            placeholder="Type your answer. Be specific: what you did, the tools, the numbers."
            autoComplete="off"
            spellCheck
          />
          <div className="flex items-center justify-between">
            <span className="muted">
              {words} words · {text.length}/{MAX_CHARS} characters · Ctrl+Enter to send
            </span>
            <button className="btn" disabled={busy || state.pending || !text.trim()} onClick={() => void send()}>
              {busy ? "Sending…" : "Send answer"}
            </button>
          </div>
          {error && <p className="error">{error}</p>}
          </>
          )}
        </div>
      )}
    </div>
  );
}
