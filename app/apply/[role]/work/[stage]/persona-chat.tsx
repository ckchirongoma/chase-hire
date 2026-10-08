"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { burstGuard, useIntegrity } from "@/lib/client/use-integrity";
import { PERSONA_MAX_MESSAGE_CHARS } from "@/lib/persona/facts";
import type { PersonaView } from "@/lib/persona/types";
import { countdown } from "@/lib/work/time";

const CONTEXT = "persona:ba_part1";

/**
 * "Interview the client": the 25-minute, 25-message chat with Lerato (BA Part 1). Paste is
 * blocked while the tab is open (logged as a signal only). The countdown is display only; the
 * server closes the chat at its deadline.
 */
export default function PersonaChat({ attemptId, visible }: { attemptId: string; visible: boolean }) {
  const [state, setState] = useState<PersonaView | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const offset = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const guard = useMemo(() => burstGuard(CONTEXT), []);
  const base = `/api/persona/${attemptId}`;

  const live = state && state.status !== "none" ? state : null;
  const chatActive = live?.status === "active";
  useIntegrity(CONTEXT, { active: visible && chatActive, blockPaste: true });

  const apply = useCallback((s: PersonaView) => {
    if (s.status !== "none") offset.current = new Date(s.serverNow).getTime() - Date.now();
    setState(s);
  }, []);

  const call = useCallback(
    async (path: string, body?: unknown, quiet = false) => {
      if (!quiet) {
        setBusy(true);
        setError(null);
      }
      try {
        const res = await fetch(`${base}/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: "no-store",
        });
        const json = await res.json().catch(() => ({}));
        if (res.status === 409 && json.state) {
          apply(json.state as PersonaView);
          setError(json.error ?? "The chat has been refreshed.");
          return false;
        }
        if (!res.ok) throw new Error(json.error ?? "Something went wrong");
        apply(json as PersonaView);
        return true;
      } catch (e) {
        if (!quiet) setError(e instanceof Error ? e.message : "Something went wrong");
        return false;
      } finally {
        if (!quiet) setBusy(false);
      }
    },
    [base, apply],
  );

  useEffect(() => {
    void call("state", undefined, true);
  }, [call]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + offset.current), 1000);
    return () => clearInterval(id);
  }, []);

  // A message is waiting for Lerato's reply (e.g. sent from another tab): poll.
  const pending = live?.status === "active" && live.pending;
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => void call("state", undefined, true), 2000);
    return () => clearInterval(id);
  }, [pending, call]);

  // After the chat deadline (+ the server's grace), fetch the closed state.
  const deadline = live ? new Date(live.deadlineAt).getTime() : null;
  const closedFetched = useRef(false);
  useEffect(() => {
    if (!chatActive || deadline === null || closedFetched.current) return;
    if (now > deadline + 5500) {
      closedFetched.current = true;
      void call("state", undefined, true);
    }
  }, [now, chatActive, deadline, call]);

  const count = live?.messages.length ?? 0;
  useEffect(() => {
    if (visible) bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [count, visible]);

  const send = async () => {
    const content = text.trim();
    if (!content || busy || !chatActive || live?.pending) return;
    if (await call("message", { content })) setText("");
  };

  if (!state) return <p className="muted">Loading the chat…</p>;

  if (state.status === "none") {
    return (
      <section className="card space-y-3 text-sm">
        <h2 className="h2">Interview the client</h2>
        <p>
          A chat with <strong>Lerato Dube, GM Virtual Sales</strong> at Kopano Connect. She is busy and answers what you ask, not what you should have
          asked.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            You have 25 minutes from when you open the chat and up to {state.cap} messages. The clock runs on our server and keeps running if you
            leave.
          </li>
          <li>Paste is turned off in the chat, so type your questions.</li>
          <li>The chat is logged and assessed. Lerato is an AI playing a fictional client.</li>
        </ul>
        {state.notice && <p className="notice">{state.notice}</p>}
        {error && <p className="error">{error}</p>}
        <button className="btn" disabled={busy || !state.canStart} onClick={() => void call("start", {})}>
          {busy ? "Opening…" : "Open the chat"}
        </button>
      </section>
    );
  }

  const left = deadline === null ? 0 : deadline - now;
  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <h2 className="h2 mb-0">Lerato Dube, GM Virtual Sales</h2>
        {state.status === "active" ? (
          <span>
            <span className="muted">{state.remaining} messages left · </span>
            <span className={`font-mono ${left < 3 * 60_000 ? "text-red-600" : ""}`} aria-label="Chat time remaining">
              {countdown(left)}
            </span>
          </span>
        ) : (
          <span className="badge">Chat ended</span>
        )}
      </div>

      <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1" data-testid="persona-transcript">
        {state.messages.map((m) => (
          <div key={m.id} className={m.role === "candidate" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={`max-w-[85%] whitespace-pre-line rounded-lg px-3 py-2 text-sm ${
                m.role === "candidate" ? "bg-slate-900 text-white" : "border border-slate-200 bg-slate-50"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {state.status === "active" && (busy || state.pending) && <p className="muted">Lerato is typing…</p>}
        <div ref={bottom} />
      </div>

      {state.status === "active" ? (
        <div className="space-y-2">
          {state.notice && <p className="notice">{state.notice}</p>}
          <label htmlFor="persona-message" className="label">
            Your message
          </label>
          <textarea
            id="persona-message"
            className="input min-h-24"
            value={text}
            maxLength={PERSONA_MAX_MESSAGE_CHARS}
            disabled={busy || state.pending || !!state.notice}
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
            placeholder="Ask Lerato a specific question."
            autoComplete="off"
            spellCheck
          />
          <div className="flex items-center justify-between">
            <span className="muted">Ctrl+Enter to send</span>
            <button className="btn" disabled={busy || state.pending || !text.trim() || !!state.notice} onClick={() => void send()}>
              {busy ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      ) : (
        <p className="notice">
          {state.closedReason === "cap"
            ? `You've used all ${state.cap} messages, so the chat has ended.`
            : state.closedReason === "submitted"
              ? "You've submitted this assessment, so the chat has ended."
              : "The chat time is up."}{" "}
          The transcript is saved with your assessment.
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
