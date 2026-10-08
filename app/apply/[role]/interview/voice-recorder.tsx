"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/** Longest single spoken answer. The recorder stops by itself at this point. */
export const MAX_ANSWER_MS = 3 * 60_000;

const PREFERRED_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return PREFERRED_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "";
}

export type Recording = { blob: Blob; mime: string; durationMs: number };

/**
 * Record → Stop → (listen back, re-record) → Send. Audio never leaves the browser until Send.
 * Microphone access is requested on the first Record press.
 */
export function VoiceRecorder({
  disabled,
  sending,
  onSend,
}: {
  disabled: boolean;
  sending: boolean;
  onSend: (r: Recording) => Promise<boolean>;
}) {
  const [phase, setPhase] = useState<"idle" | "recording" | "recorded">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTracks = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
    stopTracks();
  }, []);

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  const stop = useCallback(() => {
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("This browser can't record audio. Please use a recent Chrome, Edge, Firefox or Safari.");
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError(
        "We couldn't use your microphone. Allow microphone access for this site and try again. If you can't use a microphone, ask us for a typed interview using \"Request a review\" on your results page.",
      );
      return;
    }
    const mime = pickMimeType();
    const rec = mime ? new MediaRecorder(stream.current, { mimeType: mime }) : new MediaRecorder(stream.current);
    chunks.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.current.push(e.data);
    };
    rec.onstop = () => {
      if (timer.current) clearInterval(timer.current);
      const durationMs = Date.now() - startedAt.current;
      const type = (rec.mimeType || mime || "audio/webm").split(";")[0];
      const blob = new Blob(chunks.current, { type });
      stopTracks();
      setRecording({ blob, mime: type, durationMs });
      setUrl(URL.createObjectURL(blob));
      setPhase("recorded");
    };
    recorder.current = rec;
    startedAt.current = Date.now();
    setElapsed(0);
    rec.start(1000);
    setPhase("recording");
    timer.current = setInterval(() => {
      const ms = Date.now() - startedAt.current;
      setElapsed(ms);
      if (ms >= MAX_ANSWER_MS) stop();
    }, 250);
  }, [stop]);

  const reset = () => {
    setRecording(null);
    setUrl(null);
    setPhase("idle");
    setElapsed(0);
  };

  const send = async () => {
    if (!recording) return;
    if (recording.blob.size === 0) {
      setError("That recording was empty. Please record again.");
      reset();
      return;
    }
    if (await onSend(recording)) reset();
  };

  const secs = Math.floor(elapsed / 1000);
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

  return (
    <div className="space-y-2" data-testid="voice-recorder">
      {phase === "idle" && (
        <button className="btn" disabled={disabled || sending} onClick={() => void start()}>
          ● Record answer
        </button>
      )}
      {phase === "recording" && (
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm font-medium text-red-600" aria-live="polite">
            <span className="h-3 w-3 animate-pulse rounded-full bg-red-600" /> Recording {clock} / 3:00
          </span>
          <button className="btn" onClick={stop}>
            ■ Stop
          </button>
        </div>
      )}
      {phase === "recorded" && recording && (
        <div className="space-y-2">
          {url && <audio controls src={url} className="w-full" aria-label="Your recorded answer" />}
          <div className="flex flex-wrap gap-2">
            <button className="btn" disabled={disabled || sending} onClick={() => void send()}>
              {sending ? "Sending…" : "Send answer"}
            </button>
            <button className="btn-secondary" disabled={sending} onClick={reset}>
              Record again
            </button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
