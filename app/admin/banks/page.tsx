import Link from "next/link";
import { requireAdmin } from "@/lib/server/auth";
import { all } from "@/lib/server/query";
import { PERSONA_KEY } from "@/lib/persona/facts";
import { PERSONA_PROMPT } from "@/lib/persona/prompt";
import { checkItem, ITEM_RULES, TIER_TARGET_P, type ItemStatus, type Tier } from "@/lib/stats/item-stats";
import { recomputeItemStats } from "./actions";

export const dynamic = "force-dynamic";

type ItemRow = {
  id: string;
  family: string;
  tier: string;
  generator: string;
  form: string;
  active: boolean;
  version: number;
  exposures: number;
  difficulty_p: number | string | null;
  discrimination: number | string | null;
};

const STATUS: Record<ItemStatus, { text: string; cls: string }> = {
  insufficient: { text: "too few exposures", cls: "badge" },
  ok: { text: "in range", cls: "badge" },
  off_target: { text: "off target", cls: "badge-warn" },
  retire: { text: "retire?", cls: "badge-bad" },
};

const TIER_ORDER: Record<string, number> = { easy: 0, medium: 1, hard: 2 };
const num = (x: number | string | null) => (x === null || x === "" ? null : Number(x));

/**
 * Banks hub (docs/01 "Admin: banks"): one place that summarises every bank and links to where
 * each is managed. The reasoning item bank and its statistics live on this page; the quiz bank,
 * rubrics and live questions have their own pages; persona hidden facts are read-only here.
 */
export default async function BanksPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { supabase } = await requireAdmin();
  const { ok, error } = await searchParams;

  const [{ data: itemData }, quiz, { data: rubricData }, facts, live] = await Promise.all([
    supabase.from("reasoning_items").select("id, family, tier, generator, form, active, version, exposures, difficulty_p, discrimination"),
    all<{ role_slug: string; active: boolean }>((from, to) => supabase.from("quiz_items").select("role_slug, active").range(from, to)),
    supabase.from("rubrics").select("key, version, active").order("key").order("version"),
    supabase.from("persona_facts").select("id", { count: "exact", head: true }).eq("persona_key", PERSONA_KEY),
    supabase.from("live_questions").select("id", { count: "exact", head: true }),
  ]);

  const items = ((itemData ?? []) as ItemRow[]).sort(
    (a, b) => a.form.localeCompare(b.form) || a.family.localeCompare(b.family) || (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) || a.version - b.version,
  );
  const checked = items.map((i) => ({ ...i, check: checkItem(i) }));
  const flagged = checked.filter((i) => i.active && (i.check.status === "retire" || i.check.status === "off_target")).length;
  const forms = [...new Set(items.map((i) => i.form))];

  const quizByRole = new Map<string, { active: number; total: number }>();
  for (const q of quiz) {
    const c = quizByRole.get(q.role_slug) ?? { active: 0, total: 0 };
    c.total++;
    if (q.active) c.active++;
    quizByRole.set(q.role_slug, c);
  }

  const rubrics = new Map<string, { versions: number[]; active: number[] }>();
  for (const r of (rubricData ?? []) as { key: string; version: number; active: boolean }[]) {
    const e = rubrics.get(r.key) ?? { versions: [], active: [] };
    e.versions.push(r.version);
    if (r.active) e.active.push(r.version);
    rubrics.set(r.key, e);
  }

  return (
    <div className="space-y-6">
      <h1 className="h1">Banks</h1>
      <p className="muted">
        Every bank the assessments draw from. Changing a rubric, prompt, persona fact or model ID means re-running the gold set
        before it goes live (docs/09 §8).
      </p>
      {error && <p className="error">{error}</p>}
      {ok && <p className="notice">{ok}</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="banks-hub">
        <section className="card space-y-1 text-sm">
          <h2 className="h2">Reasoning items</h2>
          <p>
            {items.length} templates ({forms.map((f) => `${items.filter((i) => i.form === f).length} ${f}`).join(", ")}).
          </p>
          <p>{flagged ? <span className="badge-warn">{flagged} active template{flagged === 1 ? "" : "s"} flagged</span> : "No active template flagged."}</p>
          <a href="#reasoning" className="underline">Item statistics below</a>
        </section>
        <section className="card space-y-1 text-sm">
          <h2 className="h2">Role quiz</h2>
          {quizByRole.size ? (
            [...quizByRole].map(([role, c]) => (
              <p key={role}>{role}: {c.active} active of {c.total}</p>
            ))
          ) : (
            <p>No items yet.</p>
          )}
          <Link href="/admin/quiz-bank" className="underline">Manage the quiz bank</Link>
        </section>
        <section className="card space-y-1 text-sm">
          <h2 className="h2">Persona hidden facts</h2>
          <p>
            {facts.count ?? 0} facts for {PERSONA_KEY}, prompt {PERSONA_PROMPT.key}.v{PERSONA_PROMPT.version}.
          </p>
          <Link href="/admin/banks/persona" className="underline">View the facts (read-only)</Link>
        </section>
        <section className="card space-y-1 text-sm">
          <h2 className="h2">Rubrics</h2>
          {[...rubrics].map(([key, r]) => (
            <p key={key}>
              {key}: v{r.versions.join(", v")}
              {r.active.length ? ` (active v${r.active.join(", v")})` : " (none active)"}
            </p>
          ))}
          <Link href="/admin/rubrics" className="underline">Rubric versions and baselines</Link>
        </section>
        <section className="card space-y-1 text-sm">
          <h2 className="h2">Live questions</h2>
          <p>{live.error ? "Panel, live defence, elicitation and exec-scenario questions." : `${live.count ?? 0} questions with anchors.`}</p>
          <Link href="/admin/live/bank" className="underline">Manage the live question bank</Link>
        </section>
      </div>

      <section id="reasoning" className="card space-y-3">
        <h2 className="h2">Reasoning item bank and statistics</h2>
        <p className="muted">
          Every item is generated fresh per candidate from a seed, so there is no fixed answer key to leak. Each row is a
          template (family × tier × form). The nightly sweep recomputes p (proportion correct) and the point-biserial
          discrimination (each item against the rest of the score), counting the anonymised answers kept after purges too.
          Statistics count only after {ITEM_RULES.minExposures} exposures. Retire a template with discrimination below{" "}
          {ITEM_RULES.minDiscrimination}, or p above {ITEM_RULES.maxP} or below {ITEM_RULES.minP}; p should sit in its
          tier&apos;s band (easy {TIER_TARGET_P.easy.join("–")}, medium {TIER_TARGET_P.medium.join("–")}, hard{" "}
          {TIER_TARGET_P.hard.join("–")}) to keep the median applicant near 40–50% (docs/04 §4).
        </p>
        <form action={recomputeItemStats}>
          <button className="btn-secondary">Recompute now</button>
        </form>
        <div className="overflow-x-auto">
          <table className="table" data-testid="reasoning-items">
            <thead>
              <tr>
                <th>Family</th><th>Tier</th><th>Generator</th><th>Form</th><th>Active</th><th>Exposures</th><th>p</th>
                <th>Discrimination</th><th>Target p</th><th>Check</th>
              </tr>
            </thead>
            <tbody>
              {checked.map((i) => {
                const band = TIER_TARGET_P[i.tier as Tier];
                const p = num(i.difficulty_p);
                const d = num(i.discrimination);
                return (
                  <tr key={i.id}>
                    <td>{i.family}</td>
                    <td>{i.tier}</td>
                    <td>{i.generator}</td>
                    <td>{i.form}</td>
                    <td>{i.active ? "yes" : "no"}</td>
                    <td>{i.exposures}</td>
                    <td>{p === null ? "—" : p.toFixed(2)}</td>
                    <td>{d === null ? "—" : d.toFixed(2)}</td>
                    <td>{band ? band.join("–") : "—"}</td>
                    <td>
                      <span className={STATUS[i.check.status].cls}>{STATUS[i.check.status].text}</span>
                      {i.check.reasons.length > 0 && <div className="muted">{i.check.reasons.join("; ")}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
