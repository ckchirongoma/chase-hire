"use client";

type Kind = "paste_attempt" | "copy_attempt" | "blur" | "focus" | "burst_input";

let queue: { context: string; kind: Kind; payload: Record<string, string | number | boolean | null> }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;
  if (!queue.length) return;
  const signals = queue.splice(0, 20);
  queue = [];
  const body = JSON.stringify({ signals });
  // sendBeacon survives tab closes; fall back to fetch.
  if (!navigator.sendBeacon?.("/api/signals", new Blob([body], { type: "application/json" }))) {
    fetch("/api/signals", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
  }
}

/** Logs an integrity signal (batched). Signals are context for a human, never evidence alone. */
export function logSignal(context: string, kind: Kind, payload: Record<string, string | number | boolean | null> = {}) {
  queue.push({ context, kind, payload: { ...payload, at: new Date().toISOString() } });
  if (!timer) timer = setTimeout(flush, 1500);
}
