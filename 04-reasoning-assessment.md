# 04: Reasoning Assessment (30 questions / 15 minutes)

## 1. Legal framing: read this first

**What the law says**
- **EEA s8:** any "psychological test or other similar assessment" must be:
  - scientifically shown to be valid and reliable
  - applied fairly
  - not biased against any group
- The HPCSA certification requirement was deleted with effect from 1 January 2025.
- **HPCSA regulation GNR 993 (2008):** using or developing tests of "intellectual abilities, aptitude… personnel career selection" is reserved for psychologists. Nobody has tested how this applies to an in-house test built by a tech company, so it is a real grey area.

**How we design around it**
- **Name:** the product name is **"Reasoning Assessment"**, a *job-related problem-solving* assessment. Never call it "IQ", "aptitude" or "psychometric" in the UI or adverts.
- **Hurdle, not ranker:** it screens out the bottom of the pool and is weighted at only 10% of the composite. It never auto-rejects anyone.
- **Fairness checks:** store item-level data. Run reliability (KR-20) and an adverse-impact report each cohort, based only on lawfully collected, voluntary demographic data held separately.
- **Decided (7 Oct 2026):** we build and run our own assessment. There will be no psychologist review and no licensed test. We accept the residual HPCSA grey-area risk, and keep it small by:
  - using job-related framing
  - giving the test low weight
  - never auto-rejecting
  - keeping item statistics and a fairness report for each cohort

**Why it carries little weight.** The current evidence (Sackett et al. 2022) puts the predictive validity of cognitive tests at about **.31**. Structured interviews sit at **.42**, job-knowledge tests at **.40** and work samples at **.33**. Cognitive tests also show the largest group differences. So the reasoning test is the cheapest filter we have, but it is never the deciding factor.

## 2. Format

- **Length:** 30 items in 15 minutes, which works out to 30 seconds per item. That makes it closer to a power test than CCAT (50 items in 15 min, average 24/50) or Wonderlic (50 in 12, average around 22/50). The difficulty must come from the items, not from the clock.
- **Delivery:** items are served one at a time by the server. The overall `deadline_at` is enforced on the server.
- **No back-navigation.** Each item can be skipped. Unanswered items score as wrong. Show the candidate a running clock and a progress bar.
- **Answer format:** multiple choice with 5 options, which keeps the chance of a lucky guess at 20%.
- **Attempts:** one online attempt per 90 days.
- **Live retest:** the live session uses a **parallel form** of 12 items in 6 minutes, drawn from the `form='live'` pool.

## 3. Blueprint (per attempt)

| Family | Items | Why | LLM / Google resistance |
|---|---|---|---|
| Number series (parametric) | 5 | Inductive reasoning | Generated fresh each time, so it can't be looked up. LLMs can still solve it, which is why we keep a timer. |
| Data interpretation: a small table or chart in rands or percentages, 2-step calculation | 7 | Closest to the actual work: reading business data | Generated per candidate with fresh numbers |
| Logical deduction: syllogisms, ordering, scheduling constraints | 6 | Deductive reasoning | Parametric: names and constraints randomised |
| Letter series / pattern (text-based "matrix") | 4 | Abstract reasoning without images | Parametric |
| Verbal reasoning: analogies, sentence logic | 4 | Verbal reasoning, with low reading load to avoid penalising second-language English speakers | Curated bank. ICAR verbal items may be used if ICAR's terms permit commercial use; check before using. |
| Word problems: rates, ratios, estimation | 4 | Applied numeracy | Parametric |
| **Total** | **30** | | |

**Assume no item type is LLM-proof when unproctored.** Late-2025 frontier models score in the 120s–140s on puzzle IQ tests. Our controls are the timer, fresh parameters, and the **live parallel-form retest**.

## 4. Difficulty targets

**Target median applicant score: 40–50% correct.** To discriminate around the 70th–80th percentile, which is where hiring decisions sit, build the bank so that:
- about 20% of items have p ≈ .65–.80 (warm-up and floor)
- about 55% have p ≈ .30–.50
- about 25% have p ≈ .15–.30

A "50% median" is correct design, not a soft test. If the median were 80%, the strong candidates would all bunch at the top and the test couldn't separate the top 10% from the top 30%.

**Order:** each attempt draws items stratified by family and difficulty, then orders them easy → hard within the attempt. This reduces early discouragement.

**Item statistics:**
- A nightly job recomputes each item's `difficulty_p` (proportion correct) and point-biserial `discrimination`.
- Retire items with discrimination below .15, or with p above .90 or below .08.
- Items need at least 40 exposures before their stats count.

## 5. Parametric generators (implement in `lib/reasoning/generators/`)

Each generator takes a seed and difficulty parameters, and returns `{stem, options[5], answer}`.

**Distractors** must be plausible. For each item family, generate wrong options from the common error patterns: an off-by-one step, the wrong operation, the wrong row read from a table, a percentage taken of the wrong base.

**Number series**
- Difficulty levers: rule type (arithmetic, geometric, alternating two rules, second-order differences, interleaved sequences), term size, and how many terms are shown.
- Hard example: `3, 4, 8, 17, 33, ?` (differences 1, 4, 9, 16 → +25 → **58**).

**Data interpretation**
- Generate a 4×5 table, e.g. "monthly renewals by region" in rands, then ask a 2-step question such as a percentage change of a sum, or the share of a subtotal.
- Hard version: requires noticing a unit change in a footnote, e.g. "figures in R'000".

**Deduction**
- Use constraint-satisfaction puzzles: 4–5 entities and 3–5 clues.
- Generate the puzzle and verify it with a solver so it has a **unique** answer.
- Ask one question: "Who is third?"

**Letter series**
- Use alphabet position arithmetic with wrap-around, or two interleaved series.

**Word problems**
- Rates and mixtures, e.g. "Agent A clears 12 tickets/hour, B clears 8…".
- Include estimation items where the options are an order of magnitude apart.

**Bank size:** at least 150 *effective* items. Parametric families give practically unlimited instances. Curated verbal items need at least 40, so they don't repeat across retakes.

## 6. Scoring and stars

- **Raw score:** 0–30.
- **Percentile:** taken against `norm_version`.
  - Before 100 attempts exist: a provisional norm, assuming a normal distribution with mean 13.5 and SD 5. Label it "provisional" in the UI.
  - After 100 attempts: an empirical norm from our own applicant pool, recomputed each cohort.
  - Store which norm version was used for every attempt.

**Stars from percentile:**

| Percentile | Stars |
|---|---|
| < 20 | 1★ |
| 20–39 | 2★ |
| 40–59 | 3★ |
| 60–79 | 4★ |
| 80–94 | 5★ |
| ≥ 95 | 6★ |

Note: our norm group is self-selected LinkedIn applicants, not the general population. Say so on the results page.

**Hurdle:** 3★ (see doc 03). Candidates below it are queued for admin review.

**Live retest comparison:**
- Convert the live score to a percentile using the live-form norms.
- If the online percentile minus the live percentile is greater than 25 points, set `live_delta` for discussion. Research on unproctored internet tests found that verification retests flagged about 14% of test-takers.
- This is never an automatic reject. Ask the candidate about it in the room.

## 7. UI rules

- One item per screen.
- Large readable text, and no time pressure beyond the global clock.
- Keyboard selection: 1–5, then Enter.
- No copy or paste. Text selection is disabled on stems.
- Log blur and focus events.
- Results screen: the raw score, percentile and stars with a one-line explanation, and a "Request a review" button.
