import Link from "next/link";
import { requireAdmin } from "@/lib/server/auth";
import { KIND_LABEL, type ScoredKind } from "@/lib/live/scorecard";
import { CONCERN_ANCHORS, CONCERN_PROBES } from "@/lib/live/panel";
import { updateLiveQuestion } from "../actions";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  role_slug: string;
  kind: ScoredKind;
  key: string;
  position: number;
  text: string;
  probes: string[] | null;
  anchors: Record<string, string> | null;
  replaceable: boolean;
  active: boolean;
};

const ROLES = [
  { slug: "business-analyst", title: "Business Analyst" },
  { slug: "software-engineer", title: "Software Engineer" },
];
const KINDS: ScoredKind[] = ["panel_interview", "live_defence", "live_elicitation", "exec_scenario"];

/**
 * The live question bank (docs/09 §5: "write the anchors for all 12 questions before the first live
 * round; store them in banks"). Edits apply to scorecards rendered from then on; submitted
 * scorecards keep their scores. Changing anchors mid-round makes panels incomparable: avoid it.
 */
export default async function LiveBankPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { supabase } = await requireAdmin();
  const { ok, error } = await searchParams;
  const { data } = await supabase
    .from("live_questions")
    .select("id, role_slug, kind, key, position, text, probes, anchors, replaceable, active")
    .order("role_slug")
    .order("kind")
    .order("position");
  const rows = (data ?? []) as Row[];

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link href="/admin/live" className="underline">
          ← Live stage
        </Link>
      </p>
      <h1 className="h1">Live question bank</h1>
      <p className="muted">
        Fixed questions with standard probes and behavioural anchors at 1, 3 and 5 (2 and 4 are in between). On the panel interview,
        the two questions marked &quot;verification slot&quot; are replaced by questions built from the candidate&apos;s AI-interview
        verification concerns when there are any. We never score appearance, accent or fluency. Avoid changing anchors in the middle
        of a round: panels must stay comparable.
      </p>
      {error && <p className="error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}

      <details className="card text-sm">
        <summary className="cursor-pointer font-medium">Verification questions (built from AI-interview concerns)</summary>
        <p className="mt-2">Probes: {CONCERN_PROBES.join(" · ")}</p>
        <ul className="ml-5 list-disc">
          {(["1", "3", "5"] as const).map((l) => (
            <li key={l}>
              {l}: {CONCERN_ANCHORS[l]}
            </li>
          ))}
        </ul>
      </details>

      {ROLES.map((role) =>
        KINDS.map((kind) => {
          const qs = rows.filter((r) => r.role_slug === role.slug && r.kind === kind);
          if (!qs.length) return null;
          return (
            <section key={`${role.slug}:${kind}`} className="card space-y-3">
              <h2 className="h2">
                {role.title}: {KIND_LABEL[kind]} <span className="muted">({qs.filter((q) => q.active).length} active)</span>
              </h2>
              {qs.map((q) => (
                <details key={q.id} id={q.key} className="border-t border-slate-100 pt-2 text-sm">
                  <summary className="cursor-pointer">
                    <strong>{q.position}.</strong> {q.text}{" "}
                    {q.replaceable && <span className="badge-warn">verification slot</span>} {!q.active && <span className="badge-bad">inactive</span>}
                  </summary>
                  <form action={updateLiveQuestion} className="mt-2 space-y-2">
                    <input type="hidden" name="id" value={q.id} />
                    <p className="muted">key {q.key}</p>
                    <label className="label">
                      Question
                      <textarea name="text" rows={2} className="input" defaultValue={q.text} required minLength={10} maxLength={1000} />
                    </label>
                    <label className="label">
                      Standard probes (one per line)
                      <textarea name="probes" rows={4} className="input" defaultValue={(q.probes ?? []).join("\n")} />
                    </label>
                    {(["1", "3", "5"] as const).map((l) => (
                      <label key={l} className="label">
                        Anchor {l}
                        <textarea name={`anchor${l}`} rows={2} className="input" defaultValue={q.anchors?.[l] ?? ""} required />
                      </label>
                    ))}
                    <div className="flex flex-wrap gap-4">
                      <label className="inline-flex items-center gap-1">
                        <input type="checkbox" name="active" defaultChecked={q.active} /> Active
                      </label>
                      {kind === "panel_interview" && (
                        <label className="inline-flex items-center gap-1">
                          <input type="checkbox" name="replaceable" defaultChecked={q.replaceable} /> Verification slot
                        </label>
                      )}
                    </div>
                    <button className="btn-secondary">Save question</button>
                  </form>
                </details>
              ))}
            </section>
          );
        }),
      )}
    </div>
  );
}
