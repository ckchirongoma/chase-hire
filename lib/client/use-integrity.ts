"use client";
import { useEffect } from "react";
import { logSignal } from "@/lib/client/signals";

/**
 * Integrity signals for a timed stage (logged only; never evidence on their own).
 * - blocks paste (and logs it) when `blockPaste` is set: AI interview, role quiz, persona chat
 * - logs tab blur/focus
 * - logs copy attempts when `blockCopy` is set
 * Use `burstGuard` on text inputs to detect >150 chars arriving within 500 ms without key events.
 */
export function useIntegrity(context: string, opts: { active: boolean; blockPaste?: boolean; blockCopy?: boolean }) {
  useEffect(() => {
    if (!opts.active) return;
    const onVis = () => logSignal(context, document.hidden ? "blur" : "focus");
    const onPaste = (e: ClipboardEvent) => {
      if (!opts.blockPaste) return;
      e.preventDefault();
      logSignal(context, "paste_attempt", { length: e.clipboardData?.getData("text")?.length ?? 0 });
    };
    const onCopy = (e: ClipboardEvent) => {
      if (!opts.blockCopy) return;
      e.preventDefault();
      logSignal(context, "copy_attempt");
    };
    const onDrop = (e: DragEvent) => {
      if (!opts.blockPaste) return;
      e.preventDefault();
      logSignal(context, "paste_attempt", { via: "drop" });
    };
    document.addEventListener("visibilitychange", onVis);
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("copy", onCopy, true);
    document.addEventListener("drop", onDrop, true);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener("paste", onPaste, true);
      document.removeEventListener("copy", onCopy, true);
      document.removeEventListener("drop", onDrop, true);
    };
  }, [context, opts.active, opts.blockPaste, opts.blockCopy]);
}

/**
 * Returns an onChange wrapper for a textarea that logs `burst_input` when more than 150
 * characters appear within 500 ms with no keystrokes (e.g. text injected by a tool).
 */
export function burstGuard(context: string) {
  let lastKeyAt = 0;
  let lastLen = 0;
  let lastAt = Date.now();
  return {
    onKeyDown: () => {
      lastKeyAt = Date.now();
    },
    track: (value: string) => {
      const now = Date.now();
      const added = value.length - lastLen;
      if (added > 150 && now - lastAt < 500 && now - lastKeyAt > 500) {
        logSignal(context, "burst_input", { added });
      }
      lastLen = value.length;
      lastAt = now;
    },
  };
}
