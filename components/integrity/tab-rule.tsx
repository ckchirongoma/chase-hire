"use client";

/** Shown after the first time the candidate leaves the page during a timed stage. */
export function TabPauseOverlay({ open, onContinue }: { open: boolean; onContinue: () => void }) {
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="tab-pause-title" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4">
      <div className="card max-w-md space-y-3">
        <h2 id="tab-pause-title" className="h2">Paused: you left the page</h2>
        <p className="text-sm">
          Please stay on this page until you finish. The clock kept running while you were away. If you leave the page
          again, this stage will be locked until a person on our team reopens it.
        </p>
        <button className="btn" onClick={onContinue} autoFocus>
          I understand, continue
        </button>
      </div>
    </div>
  );
}

/** Shown when a timed stage is locked after the candidate left the page a second time. */
export function LockedNotice() {
  return (
    <div className="card space-y-2" data-testid="session-locked">
      <h2 className="h2">This stage is locked</h2>
      <p className="text-sm">
        You left the page a second time, so this stage is locked. A person on our team will review it and can reopen it,
        and you&apos;ll get back the time you had left. This is not a rejection. Check your results page for updates.
      </p>
      <a href="/me/results" className="btn-secondary">
        My results
      </a>
    </div>
  );
}

/** One line for intro screens, so the rule is clear before the clock starts. */
export const TAB_RULE_TEXT =
  "Stay on this page until you finish. Leaving it once pauses the stage; leaving it a second time locks it until our team reopens it (not a rejection).";
