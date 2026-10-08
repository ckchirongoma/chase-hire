import type { RubricSubcriterion } from "../schema";

/**
 * Shared rubric building blocks: the executive communication behaviours (docs/09 §4) and the
 * Spiky POV sub-criteria (docs/09 §3), with their anchors verbatim.
 */

type Sub = Omit<RubricSubcriterion, "weight" | "method" | "evidence_required" | "description"> & Partial<RubricSubcriterion>;

const sub = (s: Sub): RubricSubcriterion => ({
  weight: 1,
  method: "llm",
  evidence_required: true,
  description: "",
  prompt: "grader-criterion",
  ...s,
});

export const EXEC_COMMS: Record<"E1" | "E2" | "E3" | "E4" | "E5" | "E6" | "E7" | "E8", { title: string; anchors: Record<"1" | "3" | "5", string> }> = {
  E1: {
    title: "E1 Answer first",
    anchors: { "1": "Recommendation buried or missing", "3": "In the first paragraph, but hedged", "5": "Recommendation/ask in the first two sentences" },
  },
  E2: {
    title: "E2 Pyramid logic",
    anchors: { "1": "A list of topics or a chronology", "3": "Grouped, but overlapping", "5": "3–5 MECE supporting points, each a claim that summarises its evidence" },
  },
  E3: {
    title: "E3 SCQA framing",
    anchors: {
      "1": "No context, or too much",
      "3": "Context given, but the decision question is implicit",
      "5": "Situation + complication in 3 sentences or fewer; decision question explicit",
    },
  },
  E4: {
    title: "E4 Evidence",
    anchors: { "1": "Assertions only", "3": "Some numbers", "5": "Key claims quantified and sourced; assumptions stated" },
  },
  E5: {
    title: "E5 Decision readiness",
    anchors: { "1": "No ask", "3": "Ask without trade-offs", "5": "Options with trade-offs, risks, the specific ask, next steps with owners" },
  },
  E6: {
    title: "E6 Economy",
    anchors: { "1": "Over the limit, or padded", "3": "Within the limit, some padding", "5": "Within the limit; every paragraph earns its place" },
  },
  E7: {
    title: "E7 Composure under challenge",
    anchors: { "1": "Folds, or gets defensive", "3": "Holds the position without new reasoning", "5": "Holds with evidence, or updates with a stated reason" },
  },
  E8: {
    title: "E8 Audience calibration",
    anchors: { "1": "Jargon to an exec", "3": "Partly translated", "5": "Turns technical detail into business impact without being prompted" },
  },
};

const NOT_SCORED =
  "Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).";

/** Exec-comms sub-criteria for one artefact, e.g. written memo E1–E6 or Loom E1, E3, E5, E8. */
export function execCommsSubs(
  codes: readonly (keyof typeof EXEC_COMMS)[],
  opts: { artefact: string; sources: string[]; keyPrefix?: string; audience: string },
): RubricSubcriterion[] {
  return codes.map((code) =>
    sub({
      key: `${opts.keyPrefix ?? ""}${code.toLowerCase()}`,
      title: `${EXEC_COMMS[code].title} (${opts.artefact})`,
      description: `Executive communication behaviour ${code} (docs/09 §4) in the ${opts.artefact}, judged as ${opts.audience} would read it. ${NOT_SCORED}`,
      anchors: EXEC_COMMS[code].anchors,
      sources: opts.sources,
    }),
  );
}

/** Spiky POV sub-criteria P1–P7 (docs/09 §3). P3 needs the rubric's generic baseline. */
export function spikyPovSubs(): RubricSubcriterion[] {
  const refs = ["gold_spiky_povs", "gold_insights"];
  return [
    sub({
      key: "p1",
      title: "P1 Debatable",
      description: "Whether each POV is a position a reasonable expert could argue against, and whether the candidate states that opposite.",
      anchors: {
        "1": 'Consensus restated ("data quality matters")',
        "3": "Mildly contestable",
        "5": "A reasonable expert could argue the opposite, and the candidate states that opposite",
      },
      sources: ["memo"],
      reference_keys: refs,
    }),
    sub({
      key: "p2",
      title: "P2 Traceable",
      description: "Whether each POV rests on insights that are tied to cited facts (sheet/column/interview/source).",
      anchors: {
        "1": "No link to facts",
        "3": "Linked to one fact or source",
        "5": "Each POV rests on 2+ insights, each tied to cited facts (sheet/column/interview/source)",
      },
      sources: ["memo"],
      reference_keys: [...refs, "bundle_figures"],
    }),
    sub({
      key: "p3",
      title: "P3 Non-obvious",
      description:
        "Whether the POV reframes the problem beyond what the client said or a default AI answer says. A POV that substantially matches GENERIC_BASELINE scores at most 2.",
      anchors: {
        "1": "What the client already said, or what a default LLM answer says",
        "3": "Some reframing",
        "5": 'Reframes the problem in a way the client hadn\'t seen. Fails the "would ChatGPT say this unprompted?" test',
      },
      sources: ["memo"],
      reference_keys: refs,
      baseline: "required",
    }),
    sub({
      key: "p4",
      title: "P4 Steelman",
      description: "Whether the strongest counter-position is stated and shown to lose here, for this client.",
      anchors: { "1": "No counter-argument", "3": "A weak counter-argument", "5": "States the strongest counter-position and why it loses *here*" },
      sources: ["memo"],
      reference_keys: refs,
    }),
    sub({
      key: "p5",
      title: "P5 Business-tied",
      description: "Whether the POV is tied to money, sales or time using the client's own numbers (compare with BUNDLE FIGURES).",
      anchors: {
        "1": "No link to money, sales or time",
        "3": "Qualitative impact",
        "5": "Quantified impact in rands, sales or hours, using the client's own numbers",
      },
      sources: ["memo"],
      reference_keys: [...refs, "bundle_figures"],
    }),
    sub({
      key: "p6",
      title: "P6 Actionable",
      description: "Whether the proposed solution follows directly from the POV, including what not to build.",
      anchors: {
        "1": "The solution doesn't follow from the POV",
        "3": "Loosely follows",
        "5": "The solution is a direct consequence, including what *not* to build",
      },
      sources: ["memo"],
      reference_keys: [...refs, "gold_solution"],
    }),
    sub({
      key: "p7",
      title: "P7 Precise",
      description: "Assertiveness and scoping of the POVs; overlap between them.",
      anchors: {
        "1": 'Hedged ("might", "could"); many overlapping POVs',
        "3": "Some hedging",
        "5": 'Assertive, scoped ("except when…"), 1–3 distinct POVs',
      },
      sources: ["memo"],
      reference_keys: refs,
    }),
  ];
}
