import { createClient } from "@/lib/supabase/server";
import { consolidateMapping } from "@/lib/grading/reference";
import type { MappingItem } from "@/lib/grading/schema";
import { fmtDate } from "@/lib/format";

/**
 * Admin view of one graded subject (a work submission, or an interview): the stage score, each
 * criterion's weight / final / median / spread / review flag, expandable sub-criteria, and every
 * sample with its score, rationale, evidence quotes, answer-key mapping, red flags and extra
 * gaps, plus model and prompt version. Uses the admin's own client (admin-only SELECT under RLS).
 * Scores are advisory: they sort and flag, a person decides.
 */

type Evidence = { quote: string; location?: string };
type Extra = {
  feedback?: string;
  invalid?: boolean;
  rerun?: boolean;
  unverified_quote?: boolean;
  unverified_quotes?: string[];
  injection_in_quotes?: boolean;
  computed?: boolean;
  llm_score?: number;
  reference_mapping?: MappingRow[];
  red_flags_triggered?: { id: string; quote?: string }[];
  extra_valid_gaps?: { gap: string; quote?: string; unverified?: boolean }[];
  /** The model's output failed validation twice (sample excluded). */
  output_error?: string;
  /** Answer-key ids claimed found/partial whose quote is not in the submission (given no credit). */
  unverified_mapping?: string[];
  /** Red flags whose quote is not in the submission (not applied). */
  unverified_red_flags?: string[];
  [k: string]: unknown;
};
/** A judge's mapping item; `claimed` is set when an unverifiable claim was downgraded to missing. */
type MappingRow = MappingItem & { claimed?: MappingItem["status"]; unverified?: boolean };
type Sample = {
  criterion_key: string;
  sample_idx: number;
  score: number;
  evidence: Evidence[];
  rationale: string;
  extra: Extra;
  model: string;
  prompt_version: string;
  temperature: number;
};
type Summary = {
  criterion_key: string;
  weight: number;
  median_score: number | null;
  spread: number | null;
  needs_human_review: boolean;
  review_reason: string | null;
  human_score: number | null;
  human_reason: string | null;
  human_at: string | null;
  final_score: number | null;
  feedback: string | null;
};
type Criterion = { key: string; title: string; weight: number; method?: string; subcriteria?: Criterion[] };

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const fmt = (v: unknown) => {
  const n = num(v);
  return n === null ? "—" : Number.isInteger(n) ? String(n) : n.toFixed(2);
};
const COMPUTED_KEYS = ["recall", "points", "max", "coverage", "share", "revealed", "basis", "missing_checks", "confirm", "readme", "cap", "cap_reason", "harness_adjustments", "capped"] as const;

function StatusBadge({ status }: { status: MappingItem["status"] }) {
  const cls = status === "found" ? "badge" : status === "partial" ? "badge-warn" : "badge-bad";
  return <span className={cls}>{status}</span>;
}

function MappingTable({ mapping, title }: { mapping: { id: string; status: MappingItem["status"]; quote: string; perSample?: string[]; claimed?: string; unverified?: boolean }[]; title: string }) {
  if (!mapping.length) return null;
  return (
    <div className="mt-2">
      <p className="text-xs font-medium">{title}</p>
      <table className="table text-xs">
        <tbody>
          {mapping.map((m) => (
            <tr key={m.id}>
              <td className="w-16 font-mono">{m.id}</td>
              <td className="w-20">
                <StatusBadge status={m.status} />
                {m.unverified && (
                  <span className="badge-warn ml-1" title="The judge's quote for this item is not in the submission, so it got no credit">
                    claimed {m.claimed ?? "found"}, quote not found
                  </span>
                )}
              </td>
              {m.perSample && <td className="w-40 muted">{m.perSample.join(" · ")}</td>}
              <td>{m.quote ? <>&ldquo;{m.quote}&rdquo;</> : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SampleCard({ s }: { s: Sample }) {
  const x = s.extra ?? {};
  const computed = COMPUTED_KEYS.filter((k) => x[k] !== undefined);
  return (
    <div className="rounded border border-slate-200 p-2">
      <p className="text-xs">
        {x.computed ? "Computed" : `Sample ${s.sample_idx + 1}`}: <strong>{fmt(s.score)}</strong>
        {x.llm_score !== undefined && <span className="muted"> (judge said {x.llm_score})</span>} · {s.model} · {s.prompt_version} · T={s.temperature}
        {x.invalid && <span className="badge-bad ml-1">{x.output_error ? "unusable output (excluded)" : "no evidence (excluded)"}</span>}
        {x.rerun && <span className="badge ml-1">re-run</span>}
        {x.unverified_quote && <span className="badge-warn ml-1">quote not found</span>}
        {x.injection_in_quotes && <span className="badge-bad ml-1">injection-like quote</span>}
      </p>
      {!!s.evidence?.length && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {s.evidence.map((e, i) => (
            <li key={i}>
              &ldquo;{e.quote}&rdquo; <span className="muted">{e.location}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-xs text-slate-700">{s.rationale}</p>
      {x.output_error && <p className="error text-xs">Output error: {x.output_error}</p>}
      {!!x.unverified_mapping?.length && (
        <p className="mt-1 text-xs">
          <span className="badge-warn">no credit</span> claimed without a quote found in the submission: {x.unverified_mapping.join(", ")}
        </p>
      )}
      {!!x.unverified_red_flags?.length && (
        <p className="mt-1 text-xs">
          <span className="badge-warn">not applied</span> red flags without a quote found in the submission: {x.unverified_red_flags.join(", ")}
        </p>
      )}
      {!!computed.length && (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-xs">
          {computed.map((k) => (
            <div key={k} className="contents">
              <dt className="muted">{k.replace(/_/g, " ")}</dt>
              <dd className="font-mono break-all">{typeof x[k] === "object" ? JSON.stringify(x[k]) : String(x[k])}</dd>
            </div>
          ))}
        </dl>
      )}
      {!!x.red_flags_triggered?.length && (
        <p className="mt-1 text-xs">
          Red flags:{" "}
          {x.red_flags_triggered.map((f) => (
            <span key={f.id} className="badge-bad mr-1" title={f.quote}>
              {f.id}
            </span>
          ))}
        </p>
      )}
      {!!x.extra_valid_gaps?.length && (
        <div className="mt-1 text-xs">
          <p className="font-medium">Gaps outside the key (for a person to review)</p>
          <ul className="list-disc pl-5">
            {x.extra_valid_gaps.map((g, i) => (
              <li key={i}>
                {g.gap} {g.quote && <span className="muted">&ldquo;{g.quote}&rdquo;</span>}
                {g.unverified && <span className="badge-warn ml-1">quote not found</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <MappingTable mapping={x.reference_mapping ?? []} title="Answer-key mapping (this sample)" />
      {x.feedback && <p className="muted mt-1 text-xs">Candidate feedback: {x.feedback}</p>}
    </div>
  );
}

function Samples({ samples }: { samples: Sample[] }) {
  if (!samples.length) return <p className="muted text-xs">No samples stored.</p>;
  const mapped = samples.filter((s) => s.extra?.reference_mapping?.length);
  const ids = [...new Set(mapped.flatMap((s) => s.extra.reference_mapping!.map((m) => m.id)))].sort();
  const consolidated = mapped.length
    ? consolidateMapping(
        mapped.filter((s) => !s.extra.invalid).map((s) => s.extra.reference_mapping!),
        ids,
      )
    : [];
  return (
    <div className="mt-2 space-y-2">
      {consolidated.length > 0 && (
        <MappingTable mapping={consolidated} title="Answer-key mapping: per-item median across samples (what the score used, before harness or red-flag adjustments)" />
      )}
      {samples.map((s) => (
        <SampleCard key={`${s.criterion_key}-${s.sample_idx}`} s={s} />
      ))}
    </div>
  );
}

function CriterionRows({ c, path, summaries, samples, depth }: { c: Criterion; path: string; summaries: Map<string, Summary>; samples: Map<string, Sample[]>; depth: number }) {
  const s = summaries.get(path);
  const rows = samples.get(path) ?? [];
  const subs = c.subcriteria ?? [];
  return (
    <>
      <tr className={depth ? "bg-slate-50" : ""}>
        <td className={depth ? "pl-6" : "font-medium"}>
          {c.title}
          <span className="muted block font-mono text-xs">{path}</span>
        </td>
        <td>{fmt(s?.weight ?? c.weight)}</td>
        <td>
          <strong>{fmt(s?.final_score)}</strong>
          {s?.human_score != null && <span className="badge ml-1">human: {fmt(s.human_score)}</span>}
        </td>
        <td>{fmt(s?.median_score)}</td>
        <td>{fmt(s?.spread)}</td>
        <td>
          {s?.needs_human_review && s.human_score == null && <span className="badge-warn">needs review</span>}
          {s?.human_score != null && <span className="badge">resolved by a person</span>}
          {s?.review_reason && <p className="muted text-xs">{s.review_reason}</p>}
          {s?.human_reason && <p className="muted text-xs">Human: {s.human_reason}{s.human_at ? ` (${fmtDate(s.human_at)})` : ""}</p>}
          {!s && <span className="muted">not graded</span>}
        </td>
      </tr>
      {(rows.length > 0 || subs.length > 0) && (
        <tr className={depth ? "bg-slate-50" : ""}>
          <td colSpan={6} className={depth ? "pl-6" : ""}>
            <details>
              <summary className="cursor-pointer text-xs underline">
                {subs.length ? `${subs.length} sub-criteria` : ""}
                {subs.length && rows.length ? " · " : ""}
                {rows.length ? `${rows.length === 1 && rows[0].extra?.computed ? "computed" : `${rows.length} samples`}: ${rows.map((r) => fmt(r.score)).join(" · ")}` : ""}
              </summary>
              {rows.length > 0 && <Samples samples={rows} />}
              {subs.length > 0 && (
                <table className="table mt-2">
                  <tbody>
                    {subs.map((sc) => (
                      <CriterionRows key={sc.key} c={sc} path={`${path}.${sc.key}`} summaries={summaries} samples={samples} depth={depth + 1} />
                    ))}
                  </tbody>
                </table>
              )}
            </details>
          </td>
        </tr>
      )}
    </>
  );
}

export default async function RubricBreakdown({ subjectType, subjectId }: { subjectType: "submission" | "interview" | "gold"; subjectId: string }) {
  const supabase = await createClient();
  const [summaries, grades, job] = await Promise.all([
    supabase
      .from("grade_summaries")
      .select("criterion_key, weight, median_score, spread, needs_human_review, review_reason, human_score, human_reason, human_at, final_score, feedback, rubric_id")
      .eq("subject_type", subjectType)
      .eq("subject_id", subjectId),
    supabase
      .from("grades")
      .select("criterion_key, sample_idx, score, evidence, rationale, extra, model, prompt_version, temperature, rubric_id")
      .eq("subject_type", subjectType)
      .eq("subject_id", subjectId)
      .order("sample_idx"),
    supabase.from("grading_jobs").select("status, attempts, last_error, updated_at").eq("subject_type", subjectType).eq("subject_id", subjectId).maybeSingle(),
  ]);
  const summaryRows = (summaries.data ?? []) as (Summary & { rubric_id: string })[];
  const allSamples = (grades.data ?? []) as (Sample & { rubric_id: string })[];
  const rubricId = summaryRows[0]?.rubric_id ?? allSamples[0]?.rubric_id ?? null;
  // Samples from an earlier rubric version of the same subject are not part of this breakdown.
  const sampleRows = rubricId ? allSamples.filter((s) => s.rubric_id === rubricId) : allSamples;

  const [rubric, subject] = await Promise.all([
    rubricId ? supabase.from("rubrics").select("key, version, title, criteria").eq("id", rubricId).maybeSingle() : Promise.resolve({ data: null }),
    subjectType === "submission"
      ? supabase.from("submissions").select("score, grading_status, stage_key, created_at").eq("id", subjectId).maybeSingle()
      : subjectType === "interview"
        ? supabase.from("interview_sessions").select("score").eq("id", subjectId).maybeSingle()
        : Promise.resolve({ data: null }),
  ]);

  const byKey = new Map(summaryRows.map((s) => [s.criterion_key, s]));
  const samplesByKey = new Map<string, Sample[]>();
  for (const s of sampleRows) samplesByKey.set(s.criterion_key, [...(samplesByKey.get(s.criterion_key) ?? []), s]);
  const criteria: Criterion[] = Array.isArray(rubric.data?.criteria)
    ? (rubric.data!.criteria as Criterion[])
    : [...byKey.values()].filter((s) => !s.criterion_key.includes(".")).map((s) => ({ key: s.criterion_key, title: s.criterion_key, weight: Number(s.weight) }));
  const subjectData = (subject.data ?? null) as { score?: number | null; grading_status?: string; stage_key?: string } | null;
  const flagged = summaryRows.filter((s) => !s.criterion_key.includes(".") && s.needs_human_review && s.human_score == null).length;
  const prompts = [...new Set(sampleRows.map((s) => s.prompt_version))].sort();
  const models = [...new Set(sampleRows.map((s) => s.model))].sort();

  if (!summaryRows.length && !sampleRows.length) {
    return (
      <section className="card">
        <h2 className="h2">Rubric breakdown</h2>
        <p className="muted">
          Not graded yet{job.data ? ` (grading ${job.data.status}, attempts ${job.data.attempts})` : ""}.
          {job.data?.last_error && <span className="badge-bad ml-1">{job.data.last_error.slice(0, 160)}</span>}
        </p>
      </section>
    );
  }

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="h2">
          Rubric breakdown{rubric.data ? `: ${rubric.data.title}` : ""} {rubric.data && <span className="muted">v{rubric.data.version}</span>}
        </h2>
        <p className="text-sm">
          {subjectData?.score != null ? (
            <strong>{Number(subjectData.score).toFixed(1)}/100</strong>
          ) : (
            <span className="muted" title="The stage score stays empty until every weighted criterion has a final score (a person scores the ungraded ones)">
              no stage score{summaryRows.some((r) => !r.criterion_key.includes(".") && Number(r.weight) > 0 && r.final_score == null) ? " (some criteria are ungraded)" : ""}
            </span>
          )}{" "}
          {subjectData?.grading_status && <span className={subjectData.grading_status === "needs_review" ? "badge-warn" : subjectData.grading_status === "failed" ? "badge-bad" : "badge"}>{subjectData.grading_status.replace("_", " ")}</span>}{" "}
          {flagged > 0 && <span className="badge-warn">{flagged} criteria need human review</span>}
        </p>
      </div>
      <p className="muted">
        Advisory scores: weighted mean of criterion finals mapped to 0–100 (1 → 0, 3 → 50, 5 → 100). LLM criteria take the median of 3 samples; a spread of 2+ needs a
        person.
        {job.data && <> Grading job: {job.data.status} (attempts {job.data.attempts}).</>}
        {job.data?.last_error && <span className="badge-bad ml-1">{job.data.last_error.slice(0, 160)}</span>}
      </p>
      <p className="muted text-xs">
        Models: {models.join(", ") || "—"} · prompts: {prompts.join(", ") || "—"}
      </p>
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Criterion</th>
              <th>Weight</th>
              <th>Final</th>
              <th>Median</th>
              <th>Spread</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {criteria.map((c) => (
              <CriterionRows key={c.key} c={c} path={c.key} summaries={byKey} samples={samplesByKey} depth={0} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
