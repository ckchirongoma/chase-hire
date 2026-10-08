import type { AssembledItem } from "@/lib/reasoning/blueprint";
import { LIVE_ITEM_COUNT, LIVE_MINUTES, optionLetter } from "@/lib/live/retest";

/**
 * The printable live reasoning retest (docs/04 §2): the candidate's sheet, then the admin's answer
 * key on a separate printed page. Wording follows docs/04 §1: a job-related problem-solving
 * assessment, never "IQ", "aptitude" or "psychometric".
 */

function Stem({ item }: { item: AssembledItem }) {
  return (
    <>
      <p className="whitespace-pre-line">{item.stem.prompt}</p>
      {item.stem.table && (
        <table className="retest-table my-1 text-sm">
          <thead>
            <tr>
              {item.stem.table.columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {item.stem.table.rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {item.stem.footnote && <p className="text-xs text-slate-600">{item.stem.footnote}</p>}
    </>
  );
}

export function RetestSheet({ items, reference }: { items: AssembledItem[]; reference: string }) {
  return (
    <section className="retest-sheet space-y-4" data-testid="retest-sheet">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold">Reasoning Assessment: live form</h2>
        <p className="text-sm">
          {LIVE_ITEM_COUNT} questions · {LIVE_MINUTES} minutes · Reference {reference}
        </p>
        <p className="text-sm">Name: ______________________________ Date: ______________</p>
        <p className="text-sm text-slate-700">
          Job-related problem solving: number and letter patterns, reading a business table, logical ordering, a short verbal item and
          word problems. Circle one letter per question. Unanswered questions count as wrong, so answer every question. Work on this
          paper; a basic calculator is allowed, phones, laptops and AI tools are not.
        </p>
      </header>
      <ol className="space-y-4">
        {items.map((item) => (
          <li key={item.position} className="retest-item space-y-1" data-testid="retest-item">
            <p className="font-medium">Question {item.position}</p>
            <Stem item={item} />
            <ul className="space-y-0.5 text-sm">
              {item.options.map((o, i) => (
                <li key={i}>
                  <span className="mr-2 inline-block w-5 rounded-full border border-slate-400 text-center font-mono text-xs">{optionLetter(i)}</span>
                  {o}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function RetestKey({ items, seed, reference }: { items: AssembledItem[]; seed: number; reference: string }) {
  return (
    <section className="retest-key space-y-2" data-testid="retest-key">
      <h2 className="text-xl font-semibold">Answer key: admin only, do not hand to the candidate</h2>
      <p className="text-sm">
        Reference {reference} · seed {seed}. Count the questions answered correctly (0 to {LIVE_ITEM_COUNT}) and enter the raw score on the
        platform. Skipped questions count as wrong.
      </p>
      <table className="retest-table text-sm">
        <thead>
          <tr>
            <th>Question</th>
            <th>Answer</th>
            <th>Option</th>
            <th>Family</th>
            <th>Tier</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.position}>
              <td>{item.position}</td>
              <td className="font-mono font-semibold" data-testid="retest-answer">
                {optionLetter(item.answerIndex)}
              </td>
              <td>{item.options[item.answerIndex]}</td>
              <td>{item.family.replace("_", " ")}</td>
              <td>{item.tier}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
