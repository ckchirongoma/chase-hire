"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { STATUS_LABEL } from "@/lib/format";
import { batchAdvance } from "./actions";

export interface CardData {
  applicationId: string;
  userId: string;
  label: string;
  sub: string | null;
  roleTitle: string;
  status: string;
  composite: number | null;
  coverage: number;
  final: number | null;
  execComms: number | null;
  eligible: boolean;
  flags: string[];
}

/** One stage column: cards, selection for batch advance, and the explicit confirm step. */
export default function PipelineColumn({ stage, title, cards, back }: { stage: string; title: string; cards: CardData[]; back: string }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [threshold, setThreshold] = useState("");
  const [confirming, setConfirming] = useState(false);
  const eligible = useMemo(() => cards.filter((c) => c.eligible), [cards]);
  const chosen = cards.filter((c) => selected.has(c.applicationId));

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  /** Selects eligible, unflagged cards whose composite is at or above the threshold. */
  const selectAbove = () => {
    const t = Number(threshold);
    if (!Number.isFinite(t)) return;
    setSelected(new Set(eligible.filter((c) => c.composite !== null && c.composite >= t && c.flags.length === 0).map((c) => c.applicationId)));
  };

  return (
    <section className="w-72 shrink-0 space-y-2 rounded-md bg-slate-50 p-2" data-testid={`column-${stage}`}>
      <h2 className="text-sm font-semibold">
        {title} <span className="muted">({cards.length})</span>
      </h2>
      {eligible.length > 0 && (
        <div className="space-y-1 text-xs">
          <div className="flex items-center gap-1">
            <input
              className="input w-20 py-1 text-xs"
              inputMode="decimal"
              placeholder="min score"
              aria-label={`Minimum composite for ${title}`}
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
            <button type="button" className="underline" onClick={selectAbove}>
              Select at or above
            </button>
          </div>
          {chosen.length > 0 && !confirming && (
            <button type="button" className="btn w-full" onClick={() => setConfirming(true)}>
              Advance {chosen.length} candidate{chosen.length === 1 ? "" : "s"}…
            </button>
          )}
        </div>
      )}
      {confirming && chosen.length > 0 && (
        <form action={batchAdvance} className="space-y-2 rounded border border-amber-300 bg-white p-2 text-xs" data-testid={`confirm-${stage}`}>
          <p className="font-medium">Advance these {chosen.length} candidates to the next stage?</p>
          <ul className="list-disc pl-4">
            {chosen.map((c) => (
              <li key={c.applicationId}>
                {c.label} ({c.composite ?? "—"})
              </li>
            ))}
          </ul>
          <input type="hidden" name="ids" value={chosen.map((c) => c.applicationId).join(",")} />
          <input type="hidden" name="back" value={back} />
          <textarea
            name="reason"
            required
            minLength={20}
            rows={3}
            className="input text-xs"
            placeholder="One reason for all of them, referencing the criteria (min 20 characters)"
          />
          <label className="block">
            Type the number of candidates to confirm:
            <input name="confirm" required inputMode="numeric" className="input mt-1 py-1 text-xs" aria-label="Number of candidates to confirm" />
          </label>
          <div className="flex gap-2">
            <button className="btn">Confirm batch advance</button>
            <button type="button" className="btn-secondary" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {cards.map((c) => (
        <article key={c.applicationId} className="rounded border border-slate-200 bg-white p-2 text-xs" data-testid="pipeline-card">
          <div className="flex items-start gap-2">
            {c.eligible && (
              <input
                type="checkbox"
                className="mt-0.5"
                checked={selected.has(c.applicationId)}
                onChange={() => toggle(c.applicationId)}
                aria-label={`Select ${c.label}`}
              />
            )}
            <div className="min-w-0 flex-1">
              <Link href={`/admin/candidates/${c.userId}`} className="font-medium underline">
                {c.label}
              </Link>
              {c.sub && <p className="muted truncate">{c.sub}</p>}
              <p className="muted">
                {c.roleTitle} · {STATUS_LABEL[c.status] ?? c.status}
              </p>
              <p>
                Composite <strong>{c.composite ?? "—"}</strong>
                {c.composite !== null && c.coverage < 1 && <span className="muted"> ({Math.round(c.coverage * 100)}% of stages)</span>}
                {c.final !== null && <> · final <strong>{c.final}</strong></>}
                {c.execComms !== null && <span className="muted"> · exec comms {c.execComms}</span>}
              </p>
              {c.flags.length > 0 && (
                <p className="mt-1 flex flex-wrap gap-1">
                  {c.flags.map((f) => (
                    <span key={f} className="badge-warn">
                      {f}
                    </span>
                  ))}
                </p>
              )}
            </div>
          </div>
        </article>
      ))}
    </section>
  );
}
