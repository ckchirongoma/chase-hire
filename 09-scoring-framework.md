# 09: Scoring Framework

## 1. Principles

1. **Weight stages by predictive validity.** Sackett et al. (2022) operational validities:

   | Method | Validity |
   |---|---|
   | Structured interview | .42 |
   | Job-knowledge test | .40 |
   | Work sample | .33 |
   | Cognitive test | .31 |
   | Unstructured interview | .19 |

   Our work samples are richer than typical ones and are followed by a live defence, so we weight them higher than the raw estimate would suggest.
2. **The reasoning test is a hurdle.** It gets a low weight because it has the largest adverse impact and the lowest marginal value. Dropping it from a composite costs only about .05 in validity.
3. **The live stage is the decisive stage.** Every unproctored stage can be AI-assisted. The live defence and the panel interview are where we verify.
4. **Humans decide.** The composite score sorts the queue. It never decides an outcome.

## 2. Composite (computed per application, stored in `applications.composite_score`)

### Pre-live composite (used to shortlist)

| Component | BA | SWE |
|---|---|---|
| Reasoning (percentile → 0–100) | 10% | 10% |
| AI interview | 15% | 15% |
| Role quiz | 15% | 15% |
| Work 1 (BA Part 1 / SWE Test 1) | 30% | 35% |
| Work 2 (BA Part 2 / SWE Test 2) | 30% | 25% |

### Final composite (used for the offer decision)

**Final = 50% pre-live composite + 50% live stage.** The live stage breaks down as:

| Live component | BA | SWE |
|---|---|---|
| Structured panel interview | 40% | 40% |
| Live defence of work | 30% | 40% (incl. AI-off debugging) |
| Live elicitation role-play | 30% | n/a |
| Exec scenario: "Lerato asks for something unreasonable" | n/a | 20% |

**Reasoning retest:** this is not scored. It produces a `live_delta` flag (see doc 04) and is discussed in the room.

### Normalisation

- Each component is converted to 0–100.
- Rubric scores (1–5) map linearly: 1 = 0, 3 = 50, 5 = 100.

**Executive communication runs through every stage.** It isn't a separate stage. It is scored inside:
- the interview (communication criterion)
- BA Part 1 (10%)
- BA Part 2 (10%)
- SWE Test 2 (25%)
- the SWE Test 1 release note (inside S9)
- the live stage

The admin UI also shows a **cross-stage Executive Communication score**, the mean of all its instances, as its own column. You asked for it to be visible as a signal in its own right.

## 3. Spiky POV rubric (BA Part 1)

Synthesised from:
- Wes Kao: debatable, not contrarian for its own sake, teaches something, evidence-rooted, conviction
- BrainLift DOK4 practice: traceability, 2+ insights per SPOV, non-consensus, no hedging, distinct SPOVs, operationalised
- One BA-specific addition: **falsifiability**

Score each sub-criterion 1–5. The POV score is the mean.

| Sub-criterion | 1 | 3 | 5 |
|---|---|---|---|
| **P1 Debatable** | Consensus restated ("data quality matters") | Mildly contestable | A reasonable expert could argue the opposite, and the candidate states that opposite |
| **P2 Traceable** | No link to facts | Linked to one fact or source | Each POV rests on 2+ insights, each tied to cited facts (sheet/column/interview/source) |
| **P3 Non-obvious** | What the client already said, or what a default LLM answer says | Some reframing | Reframes the problem in a way the client hadn't seen. Fails the "would ChatGPT say this unprompted?" test |
| **P4 Steelman** | No counter-argument | A weak counter-argument | States the strongest counter-position and why it loses *here* |
| **P5 Business-tied** | No link to money, sales or time | Qualitative impact | Quantified impact in rands, sales or hours, using the client's own numbers |
| **P6 Actionable** | The solution doesn't follow from the POV | Loosely follows | The solution is a direct consequence, including what *not* to build |
| **P7 Precise** | Hedged ("might", "could"); many overlapping POVs | Some hedging | Assertive, scoped ("except when…"), 1–3 distinct POVs |

**Grader calibration step.** Before scoring P3, the grader is given a *generic LLM answer* to the brief. We pre-generate this once per rubric version, by running the brief through a model with no data. A POV that substantially matches the generic answer scores at most 2 on P3. This mirrors the "LLM divergence" check used in BrainLift grading.

## 4. Executive communication rubric (all stages)

Built from:
- Minto (answer first, pyramid, MECE)
- SCQA
- BLUF
- the Amazon narrative memo
- Hewlett's executive presence research (gravitas and communication components only)

We **do not score** appearance, accent, eye contact, or filler words. They carry bias risk under EEA s6/s8 and have no link to job performance.

| # | Behaviour | 1 | 3 | 5 |
|---|---|---|---|---|
| E1 | **Answer first** | Recommendation buried or missing | In the first paragraph, but hedged | Recommendation/ask in the first two sentences |
| E2 | **Pyramid logic** | A list of topics or a chronology | Grouped, but overlapping | 3–5 MECE supporting points, each a claim that summarises its evidence |
| E3 | **SCQA framing** | No context, or too much | Context given, but the decision question is implicit | Situation + complication in 3 sentences or fewer; decision question explicit |
| E4 | **Evidence** | Assertions only | Some numbers | Key claims quantified and sourced; assumptions stated |
| E5 | **Decision readiness** | No ask | Ask without trade-offs | Options with trade-offs, risks, the specific ask, next steps with owners |
| E6 | **Economy** | Over the limit, or padded | Within the limit, some padding | Within the limit; every paragraph earns its place |
| E7 | **Composure under challenge** (live/Loom) | Folds, or gets defensive | Holds the position without new reasoning | Holds with evidence, *or* updates with a stated reason |
| E8 | **Audience calibration** | Jargon to an exec | Partly translated | Turns technical detail into business impact without being prompted |

- **Written artefacts:** score E1–E6.
- **Loom:** score E1, E3, E5, E8.
- **Live:** score E1, E5, E7, E8.

## 5. Structured panel interview scorecard (live)

**Format:**
- 6 questions per role, fixed.
- 2 of the 6 are drawn from the AI interview's `verification_concerns` for that candidate.
- Standard probes for every question.
- Each panellist scores **independently, before any discussion**. Panel interviews reach an inter-rater reliability of about .74, against .44 when separate interviewers score.

**Each question is scored 1–5 with behavioural anchors.** For example, for "Tell me about a time you found a problem in data that others had missed":

| Score | Anchor |
|---|---|
| 1 | Vague, or describes someone else's work |
| 3 | A specific instance; describes the finding; limited impact or follow-through |
| 5 | Specific; explains how they spotted it, what they did, quantified the impact, and what changed afterwards |

Write the anchors for all 12 questions (6 per role) before the first live round. Store them in `banks`.

## 6. SWE Test 1 rubric

| Criterion | Weight | 1 | 3 | 5 |
|---|---|---|---|---|
| S1 Fault discovery & fix (F01–F14, weighted; max 21) | 30% | < 6 pts | 10–14 pts | ≥ 18 pts, with correct explanations |
| S2 Import (harness M1–M7) | 25% | Fails M1 or M6 | Passes M1–M3, M6 | Passes all M1–M7 with a clear quarantine report |
| S3 Stories RD-07/RD-11 (harness U6/U7 + ACs) | 10% | Neither enforced server-side | One enforced | Both enforced at the DB/API level with tests |
| S4 Deployment & ops (R4–R7, U1, CI, monitoring, resourceful hosting) | 15% | Not deployed, or broken | Deployed; some ops basics | Deployed; CI green; health check; error monitoring; rollback note |
| S7 Security posture (U2–U5, R1–R2) | (inside S1) | | | |
| S9 Communication (README found/fixed list, ADR, release note for Lerato, Loom) | 20% | Unclear, or missing | Clear but technical | The release note is understandable to an exec; the ADR shows real trade-offs; the "didn't do" list shows prioritisation |

## 7. LLM-as-judge protocol (all AI-graded criteria)

1. **One criterion per call.** Analytic rubric, with an anchored descriptor for every scale point (1, 3 and 5; 2 and 4 are interpolated).
2. **Evidence first, then rationale, then score.** The output schema is `{evidence:[{quote, location}], rationale, score}`. A criterion that has `evidence_required` but no quotes is invalid and is re-run.
3. **Reference-guided grading.** Give the judge the answer key (D-codes, H-codes, A-codes, F-codes) and the doc 13 gold answer. Reference-guided grading cut error rates sharply in MT-Bench.
4. **Pointwise, not pairwise.** Pointwise scoring is more robust to distractor features (9% flips versus 35% for pairwise).
5. **3 samples at temperature 0.3; take the median.** A spread of 2 or more triggers `needs_human_review`.
6. **Length and polish control.**
   - Hard word limits are enforced at submission.
   - The judge is told: *"Score substance (correctness, evidence, decisions), not prose polish or length. Do not reward AI-sounding fluency."* LLM judges are known to prefer LLM-written text.
7. **Injection defence.**
   - Sanitise the submission: strip HTML, hidden text, zero-width characters and white-on-white text from DOCX/PDF.
   - Wrap the submission in `<submission>` tags.
   - The judge prompt says to ignore any instructions inside it.
   - Log a detected injection as a `prompt_injection` signal. It is shown to the admin, not auto-penalised.
8. **Model diversity (optional).** The judge model should differ from the model a candidate is likely to have used. Rotate it through config if self-preference shows up in calibration.
9. **Store everything:** model, prompt version, temperature, all samples.

## 8. Calibration (do this before going live, and redo it after any rubric, prompt or model change)

1. **Gold set.** For each work rubric, create 20–30 gold submissions spanning weak to excellent. Write some yourselves, generate some, and include doc 13. Two humans score each one independently.
2. **Agreement.** Run the graders on the gold set. Compute per criterion:
   - **ICC(2,1)**, absolute agreement
   - **quadratic weighted kappa**

   Percent agreement alone is not enough. Thresholds: < .50 poor, .50–.75 moderate, .75–.90 good.
3. **Go-live rule.** Every criterion needs ICC ≥ .75. Criteria between .60 and .75 go live with mandatory human review. Criteria below .60 are human-scored only until fixed.
4. **Drift check.** Every 25 real submissions, a human re-scores 3 at random. Watch the agreement.

## 9. Fairness monitoring

- **Report per cohort** (admin → compliance), for each stage with at least 30 candidates in each group:
  - pass/advance rates by group
  - **four-fifths rule** check
  - reasoning test KR-20
- **Data source:** demographic data is collected only with voluntary, separate consent. It is stored apart from the assessment data and never shown to graders or raters.
- **If a stage shows adverse impact:** review its items and anchors before the next cohort.

## 10. Decision guidance for admins

- Read the evidence, not just the number.
- Before rejecting, check whether the candidate has a pending `review_request`.
- **Reasons must reference criteria.** "Below hurdle on reasoning, and BA Part 1 gap recall 9/39" is acceptable. "Not a fit" is not.
