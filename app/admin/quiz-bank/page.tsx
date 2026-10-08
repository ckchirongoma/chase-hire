import Link from "next/link";
import { requireAdmin } from "@/lib/server/auth";
import { BANK_DEPTH_TARGET, BLUEPRINT, isQuizRole, QUIZ_ROLES, topicLabel, type QuizRole } from "@/lib/quiz/blueprint";
import { addQuizItem, toggleQuizItem } from "./actions";
import { bankUrl } from "./url";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<QuizRole, string> = {
  "software-engineer": "Software Engineer",
  "business-analyst": "Business Analyst",
};

const LETTERS = "ABCDE";

type Item = {
  id: string;
  topic: string;
  stem: string;
  options: string[];
  answer_key: number[];
  multi: boolean;
  active: boolean;
  exposures: number;
  version: number;
};
type Stat = { item_id: string; served: number; answered: number; correct: number; p_value: number | null; mean_seconds: number | null };

export default async function QuizBankPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string; topic?: string; error?: string; ok?: string }>;
}) {
  const { supabase } = await requireAdmin();
  const sp = await searchParams;
  const role: QuizRole = sp.role && isQuizRole(sp.role) ? sp.role : "software-engineer";
  const blueprint = BLUEPRINT[role];
  const topic = blueprint.some((b) => b.topic === sp.topic) ? sp.topic : undefined;

  const [{ data: itemRows, error: itemErr }, { data: statRows }] = await Promise.all([
    supabase
      .from("quiz_items")
      .select("id, topic, stem, options, answer_key, multi, active, exposures, version")
      .eq("role_slug", role)
      .order("created_at"),
    supabase.from("quiz_item_stats").select("item_id, served, answered, correct, p_value, mean_seconds"),
  ]);
  const items = (itemRows ?? []) as Item[];
  const stats = new Map(((statRows ?? []) as Stat[]).map((s) => [s.item_id, s]));
  const topicOrder = blueprint.map((b) => b.topic);
  const shown = items
    .filter((i) => !topic || i.topic === topic)
    .sort((a, b) => topicOrder.indexOf(a.topic) - topicOrder.indexOf(b.topic));

  return (
    <div className="space-y-6">
      <h1 className="h1">Role quiz bank</h1>
      <p className="muted">
        Each attempt draws 15 items at random, stratified by topic, and shuffles the options. Keep at least{" "}
        {BANK_DEPTH_TARGET}× the per-attempt count active in every topic so items are not over-exposed. The p value is the
        share of candidates who got the item right (finished attempts only); treat it as noisy below 40 exposures.
      </p>

      <nav className="flex gap-4 text-sm">
        {QUIZ_ROLES.map((r) => (
          <Link key={r} href={bankUrl(r)} className={r === role ? "font-semibold underline" : "underline"}>
            {ROLE_LABEL[r]}
          </Link>
        ))}
      </nav>

      {sp.error && <p className="error">{sp.error}</p>}
      {sp.ok && <p className="notice">{sp.ok}</p>}
      {itemErr && <p className="error">{itemErr.message}</p>}

      <section className="card">
        <h2 className="h2">Coverage: {ROLE_LABEL[role]}</h2>
        <table className="table">
          <thead>
            <tr><th>Topic</th><th>Per attempt</th><th>Active items</th><th>Inactive</th><th>Bank depth</th><th></th></tr>
          </thead>
          <tbody>
            {blueprint.map((b) => {
              const active = items.filter((i) => i.topic === b.topic && i.active).length;
              const inactive = items.filter((i) => i.topic === b.topic && !i.active).length;
              return (
                <tr key={b.topic}>
                  <td>{topicLabel(b.topic)}</td>
                  <td>{b.count}</td>
                  <td>{active}</td>
                  <td>{inactive}</td>
                  <td>
                    {active < b.count ? (
                      <span className="badge-bad">quiz cannot be built</span>
                    ) : active < b.count * BANK_DEPTH_TARGET ? (
                      <span className="badge-warn">thin ({(active / b.count).toFixed(1)}×)</span>
                    ) : (
                      <span className="badge">{(active / b.count).toFixed(1)}×</span>
                    )}
                  </td>
                  <td>
                    <Link href={bankUrl(role, { topic: b.topic })} className="underline">show</Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="h2 mb-0">
            Items{topic ? `: ${topicLabel(topic)}` : ""} ({shown.length})
          </h2>
          {topic && <Link href={bankUrl(role)} className="text-sm underline">Show all topics</Link>}
        </div>
        <table className="table">
          <thead>
            <tr><th>Topic</th><th>Question</th><th>Type</th><th>Exposures</th><th>p</th><th>Mean time</th><th>Active</th></tr>
          </thead>
          <tbody>
            {shown.map((i) => {
              const s = stats.get(i.id);
              return (
                <tr key={i.id} className={i.active ? "" : "opacity-60"}>
                  <td className="whitespace-nowrap">{topicLabel(i.topic)}</td>
                  <td>
                    <details>
                      <summary className="cursor-pointer">{i.stem}</summary>
                      <ol className="mt-1 space-y-0.5">
                        {i.options.map((o, idx) => (
                          <li key={idx} className={i.answer_key.includes(idx) ? "font-medium text-green-700" : ""}>
                            {LETTERS[idx]}. {o}
                            {i.answer_key.includes(idx) ? " ✓" : ""}
                          </li>
                        ))}
                      </ol>
                    </details>
                  </td>
                  <td>{i.multi ? <span className="badge">select all</span> : "single"}</td>
                  <td>{i.exposures}</td>
                  <td>{s?.p_value != null ? Number(s.p_value).toFixed(2) : "—"}</td>
                  <td>{s?.mean_seconds != null ? `${Number(s.mean_seconds)}s` : "—"}</td>
                  <td>
                    <form action={toggleQuizItem}>
                      <input type="hidden" name="id" value={i.id} />
                      <input type="hidden" name="role" value={role} />
                      {topic && <input type="hidden" name="topic" value={topic} />}
                      <input type="hidden" name="active" value={i.active ? "false" : "true"} />
                      <button className="btn-secondary px-2 py-1 text-xs">{i.active ? "Deactivate" : "Activate"}</button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card space-y-3">
        <h2 className="h2">Add an item</h2>
        <p className="muted">
          Keep the reading load low and the wording plain. Options are shuffled for each candidate, so never refer to
          other options (&quot;all of the above&quot;, &quot;both A and B&quot;). Use synthetic examples only: no client
          names, client figures or anything from the work assessments.
        </p>
        <form action={addQuizItem} className="space-y-3">
          <div>
            <label className="label" htmlFor="role_topic">Role and topic</label>
            <select id="role_topic" name="role_topic" className="input" defaultValue={`${role}:${topic ?? blueprint[0]!.topic}`}>
              {QUIZ_ROLES.map((r) => (
                <optgroup key={r} label={ROLE_LABEL[r]}>
                  {BLUEPRINT[r].map((b) => (
                    <option key={b.topic} value={`${r}:${b.topic}`}>
                      {topicLabel(b.topic)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="stem">Question</label>
            <textarea id="stem" name="stem" className="input" rows={3} required minLength={10} maxLength={1000} />
          </div>
          <div>
            <label className="label" htmlFor="options">Options (4 or 5, one per line)</label>
            <textarea id="options" name="options" className="input" rows={5} required />
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="label" htmlFor="correct">Correct option number(s)</label>
              <input id="correct" name="correct" className="input w-40" placeholder="e.g. 2 or 1, 3" required />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="multi" /> Select all that apply (all-or-nothing)
            </label>
          </div>
          <button className="btn">Add item</button>
        </form>
      </section>
    </div>
  );
}
