import { createHash } from "node:crypto";
import Link from "next/link";
import { requireAdmin } from "@/lib/server/auth";
import { elicitationPoints, PERSONA_KEY, PERSONA_MESSAGE_CAP, VOLUNTEER_TOPICS, type PersonaFact } from "@/lib/persona/facts";
import { FACT_THRESHOLD, MAX_FACTS_PER_TURN } from "@/lib/persona/gate";
import { PERSONA_PROMPT } from "@/lib/persona/prompt";

export const dynamic = "force-dynamic";

/**
 * Read-only view of the BA Part 1 stakeholder persona's hidden facts (persona_facts, admin-only
 * under RLS; never sent to a candidate's browser). The fingerprint changes whenever any fact,
 * trigger or weight changes, so a calibration run can be matched to the fact set it used.
 */
export default async function PersonaFactsPage() {
  const { supabase } = await requireAdmin();
  const { data, error } = await supabase
    .from("persona_facts")
    .select("id, fact, triggers, weight, volunteer_on")
    .eq("persona_key", PERSONA_KEY)
    .order("id");
  const facts = (data ?? []) as PersonaFact[];
  const fingerprint = createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 12);
  const { max } = elicitationPoints([], facts);

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link href="/admin/banks" className="underline">Banks</Link> / Persona hidden facts
      </p>
      <h1 className="h1">Persona hidden facts: {PERSONA_KEY}</h1>
      <dl className="card grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="muted">Prompt</dt><dd>prompts/{PERSONA_PROMPT.key}.v{PERSONA_PROMPT.version}.md</dd></div>
        <div><dt className="muted">Fact set fingerprint</dt><dd className="font-mono">{fingerprint}</dd></div>
        <div><dt className="muted">Facts / elicitation points</dt><dd>{facts.length} facts, {max} weighted points</dd></div>
        <div><dt className="muted">Gating</dt><dd>JEV gate ≥ {FACT_THRESHOLD}, at most {MAX_FACTS_PER_TURN} facts a turn, {PERSONA_MESSAGE_CAP} candidate messages</dd></div>
      </dl>
      <p className="muted">
        The persona reveals a fact only when the candidate&apos;s question matches its triggers (or, for a volunteer topic, the
        first time the topic comes up). The elicitation grader scores the weighted share revealed (docs/06 Part 1). Changes
        go through a migration and need a gold-set re-run before going live.
      </p>
      {error && <p className="error">{error.message}</p>}
      <table className="table card" data-testid="persona-facts">
        <thead>
          <tr><th>Id</th><th>Fact</th><th>Triggers</th><th>Weight</th><th>Volunteered on</th></tr>
        </thead>
        <tbody>
          {facts.map((f) => (
            <tr key={f.id}>
              <td className="font-mono">{f.id}</td>
              <td>{f.fact}</td>
              <td>{f.triggers.join("; ")}</td>
              <td>{f.weight}</td>
              <td>{f.volunteer_on ? (VOLUNTEER_TOPICS[f.volunteer_on]?.question ?? f.volunteer_on) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
