"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tab rule for a timed stage. When the page comes back after being hidden for 2+ seconds, the
 * server records it: the first time the stage is paused (the candidate confirms to continue),
 * the second time it is locked until an admin reopens it. The clock keeps running while paused.
 */
export function useTabRule(opts: { kind: "reasoning" | "quiz" | "interview"; id: string | null; active: boolean; onLocked?: () => void }) {
  const [paused, setPaused] = useState(false);
  const [locked, setLocked] = useState(false);
  const hiddenAt = useRef<number | null>(null);
  const { kind, id, active, onLocked } = opts;

  useEffect(() => {
    if (!active || !id) return;
    const onVis = () => {
      if (document.hidden) {
        hiddenAt.current = Date.now();
        return;
      }
      const since = hiddenAt.current;
      hiddenAt.current = null;
      if (since === null) return;
      const hiddenMs = Date.now() - since;
      if (hiddenMs < 2000) return;
      fetch("/api/integrity/leave", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, id, hiddenMs }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { status?: string } | null) => {
          if (j?.status === "paused") setPaused(true);
          if (j?.status === "locked") {
            setLocked(true);
            setPaused(false);
            onLocked?.();
          }
        })
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [kind, id, active, onLocked]);

  const resume = useCallback(() => setPaused(false), []);
  return { paused, locked, resume };
}
