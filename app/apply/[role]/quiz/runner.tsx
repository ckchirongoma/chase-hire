"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useIntegrity } from "@/lib/client/use-integrity";
import { useTabRule } from "@/lib/client/use-tab-rule";
import { LockedNotice, TabPauseOverlay } from "@/components/integrity/tab-rule";
import { QuizScore } from "@/components/results/quiz-score";
import { quizClock } from "@/lib/quiz/clock";
import type { QuizState } from "@/lib/server/quiz";

export default function Runner({
  role,
  initial,
  itemCount,
  minutes,
}: {
  role: string;
  initial: QuizState;
  itemCount: number;
  minutes: number;
}) {
  const [state, setState] = useState<QuizState>(initial);
  const [choice, setChoice] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [timeUp, setTimeUp] = useState(false);
  const offset = useRef(0); // server clock minus client clock
  // Last expiry check (server clock) per attempt; see lib/quiz/clock.ts.
  const lastCheck = useRef<{ attemptId: string; at: number } | null>(null);
  const active = state.status === "active";

  // Integrity signals (logged only, never evidence on their own): paste and copy are
  // blocked and logged, and tab switches are logged.
  useIntegrity(`quiz:${role}`, { active, blockPaste: true, blockCopy: true });

  useEffect(() => {
    if (initial.status === "active") offset.current = new Date(initial.serverNow).getTime() - Date.now();
  }, [initial]);

  const apply = useCallback((s: QuizState) => {
    setState(s);
    setChoice([]);
    if (s.status === "active") offset.current = new Date(s.serverNow).getTime() - Date.now();
  }, []);

  const call = useCallback(
    async (path: "start" | "state" | "next", body?: unknown) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/quiz/${role}/${path}`, {
          method: path === "state" ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Something went wrong");
        apply(json as QuizState);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
      } finally {
        setBusy(false);
      }
    },
    [role, apply],
  );

  const refreshState = useCallback(() => void call("state"), [call]);
  const tab = useTabRule({ kind: "quiz", id: state.status === "active" ? state.attemptId : null, active, onLocked: refreshState });

  // Display-only countdown; the server enforces the deadline. Once the server's grace
  // period has passed, controls are disabled and the runner asks for the final state
  // (re-asking every few seconds until the server reports it finished).
  useEffect(() => {
    if (state.status !== "active") {
      setTimeUp(false);
      return;
    }
    const deadline = new Date(state.deadlineAt).getTime();
    const tick = () => {
      const now = Date.now() + offset.current;
      const last = lastCheck.current?.attemptId === state.attemptId ? lastCheck.current.at : null;
      const clock = quizClock(deadline, now, last);
      setRemaining(clock.remainingMs);
      setTimeUp(!clock.acceptsAnswers);
      if (clock.expiryCheckDue) {
        lastCheck.current = { attemptId: state.attemptId, at: now };
        call("state");
      }
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [state, call]);

  const toggle = useCallback(
    (i: number) => {
      if (state.status !== "active" || i >= state.item.options.length) return;
      if (state.item.multi) setChoice((c) => (c.includes(i) ? c.filter((x) => x !== i) : [...c, i].sort((a, b) => a - b)));
      else setChoice([i]);
    },
    [state],
  );

  const submit = useCallback(
    (answer: number[] | null) => {
      if (state.status !== "active" || busy || timeUp) return;
      call("next", { attemptId: state.attemptId, position: state.item.position, answer });
    },
    [state, busy, timeUp, call],
  );

  useEffect(() => {
    if (state.status !== "active") return;
    const onKey = (e: KeyboardEvent) => {
      if (tab.paused) return;
      if (e.ctrlKey || e.metaKey || e.altKey || timeUp) return;
      if (e.key >= "1" && e.key <= "5") {
        e.preventDefault();
        toggle(Number(e.key) - 1);
      } else if (e.key === "Enter" && (e.target as HTMLElement | null)?.tagName !== "BUTTON" && choice.length) {
        e.preventDefault();
        submit(choice);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, choice, toggle, submit, timeUp, tab.paused]);

  if (state.status === "locked" || tab.locked) {
    return <LockedNotice />;
  }

  if (state.status === "none") {
    return (
      <div className="space-y-4">
        <div className="card space-y-2 text-sm">
          <p>
            {itemCount} questions in {minutes} minutes. It checks the job knowledge this role uses day to day.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>One question at a time. You can&apos;t go back, but you can skip. Skipped questions count as not correct.</li>
            <li>
              Some questions say <strong>Select all that apply</strong>. For those you need every correct option, and no
              wrong ones, to get the mark.
            </li>
            <li>The clock runs on our server. If your connection drops, come back to this page; the clock keeps running.</li>
            <li>Use keys 1–5 to choose (or tick, on select-all questions) and Enter to confirm.</li>
            <li>Copy and paste are switched off.</li>
            <li>
              Stay on this page until you finish. Leaving it once pauses the quiz; leaving it a second time locks it until our
              team reopens it (not a rejection).
            </li>
            <li>You get one attempt. Find a quiet {minutes} minutes before you start.</li>
          </ul>
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn" disabled={busy} onClick={() => call("start", {})}>
          {busy ? "Starting…" : `Start the ${minutes}-minute quiz`}
        </button>
      </div>
    );
  }

  if (state.status === "closed") {
    return (
      <div className="card space-y-3" data-testid="quiz-closed">
        <h2 className="h2">This quiz has ended</h2>
        <p className="text-sm">
          Your application for this role is closed, so no more questions will be shown. Anything you answered has been
          saved. Your results, and the reasons for our decision, are on your results page, where you can also ask a
          person to review them.
        </p>
        <Link href="/me/results" className="btn">
          See my results
        </Link>
      </div>
    );
  }

  if (state.status === "done") {
    const r = state.result;
    return (
      <div className="card space-y-4" data-testid="quiz-done">
        <h2 className="h2">Quiz complete</h2>
        <QuizScore rawScore={r.rawScore} total={r.total} pct={r.pct} topicScores={r.topicScores} roleSlug={role} />
        <p className="notice">
          What happens next: our team reviews your results; no decision is automatic. You can see your results, and ask
          for a review, at any time.
        </p>
        <Link href="/me/results" className="btn">
          See my results
        </Link>
      </div>
    );
  }

  const { item } = state;
  const mins = remaining == null ? "--" : Math.floor(remaining / 60000);
  const secs = remaining == null ? "--" : Math.floor((remaining % 60000) / 1000).toString().padStart(2, "0");

  return (
    <div className="card space-y-4 select-none" onContextMenu={(e) => e.preventDefault()}>
      <TabPauseOverlay open={tab.paused} onContinue={tab.resume} />
      <div className="flex items-center justify-between text-sm">
        <span>
          Question {item.position} of {item.total}
        </span>
        <span
          className={`font-mono text-lg ${remaining != null && remaining < 60000 ? "text-red-600" : ""}`}
          aria-label="Time remaining"
        >
          {mins}:{secs}
        </span>
      </div>
      <div className="h-1 w-full rounded bg-slate-100">
        <div className="h-1 rounded bg-slate-900" style={{ width: `${((item.position - 1) / item.total) * 100}%` }} />
      </div>

      <p className="whitespace-pre-line text-lg" data-testid="stem">
        {item.stem}
      </p>
      {item.multi && <p className="badge-warn">Select all that apply</p>}

      <div className="grid gap-2" role={item.multi ? "group" : "radiogroup"}>
        {item.options.map((opt, i) => {
          const on = choice.includes(i);
          return (
            <label
              key={`${item.position}-${i}`}
              className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 ${on ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white hover:bg-slate-50"}`}
            >
              <input
                type={item.multi ? "checkbox" : "radio"}
                name={`q${item.position}`}
                className="mt-1"
                checked={on}
                disabled={timeUp}
                onChange={() => toggle(i)}
              />
              <span>
                <span className="mr-2 font-mono">{i + 1}.</span>
                {opt}
              </span>
            </label>
          );
        })}
      </div>

      {timeUp && (
        <p className="notice" data-testid="quiz-time-up">
          Time is up. We&apos;re saving your answers and working out your result…
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <div className="flex gap-3">
        <button className="btn" disabled={choice.length === 0 || busy || timeUp} onClick={() => submit(choice)}>
          Confirm answer
        </button>
        <button className="btn-secondary" disabled={busy || timeUp} onClick={() => submit(null)}>
          Skip
        </button>
      </div>
    </div>
  );
}
