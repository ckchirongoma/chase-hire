"use client";
import { useCallback, useEffect, useRef, useState } from "react";

type Kind = "reasoning" | "quiz" | "interview";

/**
 * Tab rule for a timed stage. The page tells the server when it goes away (hidden, closed,
 * reloaded, or left for another page) and when it is showing again, including when the stage is
 * opened again after the tab was closed. The server times the absence with its own clock: 2+
 * seconds away pauses the stage the first time (the candidate confirms to continue) and locks it
 * the second time until an admin reopens it. The clock keeps running while paused.
 */
export function useTabRule(opts: { kind: Kind; id: string | null; active: boolean; onLocked?: () => void }) {
  const [paused, setPaused] = useState(false);
  const [locked, setLocked] = useState(false);
  const onLockedRef = useRef(opts.onLocked);
  onLockedRef.current = opts.onLocked;
  const { kind, id, active } = opts;

  useEffect(() => {
    if (!active || !id) return;
    const url = "/api/integrity/presence";
    let hiddenAt: number | null = null;

    const away = (reason: "hidden" | "closed") => {
      const body = JSON.stringify({ event: "away", kind, id, reason });
      const sent = typeof navigator.sendBeacon === "function" && navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      if (!sent) void fetch(url, { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body }).catch(() => {});
    };
    const back = (hiddenMs: number | null) => {
      fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "back", kind, id, hiddenMs }) })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { status?: string } | null) => {
          if (j?.status === "paused") setPaused(true);
          if (j?.status === "locked") {
            setLocked(true);
            setPaused(false);
            onLockedRef.current?.();
          }
        })
        .catch(() => {});
    };

    // Showing now: if the candidate closed or reloaded the page earlier, the server counts it.
    back(null);
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        away("hidden");
      } else {
        back(hiddenAt === null ? null : Date.now() - hiddenAt);
        hiddenAt = null;
      }
    };
    const onPageHide = () => away("closed");
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) back(null); // restored from the back/forward cache
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      // Leaving the stage page inside the app (or the stage ended: then the server ignores it).
      away("closed");
    };
  }, [kind, id, active]);

  const resume = useCallback(() => setPaused(false), []);
  return { paused, locked, resume };
}
