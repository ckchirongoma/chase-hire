# 08: SWE Test 2, Architecture and Costing (Catalogue Protection)

**Work window:** 24 hours from Start, about 3–4 hours of intended effort.

**Environment:** done **inside the platform**. Candidates read the brief and the data room there, then upload a memo and a Loom. It is separate from Test 1.

**Anonymisation (mandatory):** the scenario is based on a real proposal, so all identifying details are replaced.

| Real | In the test |
|---|---|
| Label | **"Mzansi Heritage Records"**, a fictional SA label |
| Its platform | **"Stage"** |
| Aggregator | **"a global distribution aggregator"** |

Real names, our pricing and our proposal never appear. Our real proposal (R525k build, R20–35k/month to run) is used **only internally**, as one reference point when grading.

## Why this test

It tests whether the candidate can scope, cost, secure and phase a system before anyone writes code. The scenario is full of judgement traps where the obvious build is the wrong one. Those traps separate engineers with architecture judgement from engineers who build whatever is asked.

## Candidate brief (render verbatim)

> **Client:** Mzansi Heritage Records, a South African label with a **127,000-track catalogue** going back decades.
>
> **How their music reaches the world:** a global aggregator distributes the catalogue to about 250 streaming and social platforms. The aggregator also handles YouTube for them.
>
> **What they want, in the CEO's words:**
> *"I want our own system that finds every unauthorised use of our music: YouTube, TikTok, Instagram, random websites, and our own platform, Stage, where producers can now download stems. Find it, prove it's ours, and send it to legal so they can take it down. Our legal head wants takedowns to go out automatically, so we're not paying people to click buttons. Budget-wise I'm thinking R15,000 a month to run."*
>
> **Data room** (in the platform):
> - **Current stack:**
>   - catalogue metadata in FileMaker
>   - Stage runs on Postgres + S3
>   - masters are 24-bit WAV, some 96 kHz
>   - an internal team has started a fingerprint database; it's about 40% done
> - **People:** a 4-person engineering team (Stage), plus a publishing team and a legal team (2 people).
> - **Volume hint:** Stage gets about 300 stem downloads a day.
> - **Note from legal:** *"We'd like to start with YouTube. We see our songs everywhere there."*
>
> **Deliver:**
> 1. **A memo** (PDF/DOCX/MD, max 6 pages including diagrams), structured as:
>    - **Executive summary for the CEO** (½ page): your recommendation, cost, timeline, and the decisions you need from them.
>    - **Architecture:**
>      - a diagram
>      - components
>      - data flow (Extract → Match → Score → Remember → Route)
>      - what you **build** vs **buy** vs **register for**, and why
>    - **Platform reality:** what you can and can't reach on each platform, and how.
>    - **Cost model in rands:**
>      - build cost (effort estimate)
>      - monthly running cost broken into drivers, with **your assumptions stated**
>      - sensitivity: what moves the number
>      - USD → ZAR conversions shown
>    - **Security:** how you protect unreleased masters and the evidence trail.
>    - **Maintenance & operations:** what breaks over time, who watches it, cost.
>    - **Risks, and what you'd tell the CEO they can't have.**
>    - **Phased plan:** phases with exit criteria, and at least one **kill criterion** (a result that should stop or redirect the project).
> 2. **A 5-minute Loom** pitching your recommendation to the CEO. They are not technical.
>
> **Rules:**
> - Research is expected; cite sources.
> - Where a vendor doesn't publish prices, say so and state your assumption. Don't invent precision.
> - AI tools are allowed.
> - We will not use your work commercially, and you keep copyright.

## Answer key (internal)

Based on the research of October 2026; see doc 14. The grader maps the memo to these points. Weights: 3 = critical judgement, 2 = important, 1 = good.

| ID | A strong candidate concludes… | Wt |
|---|---|---|
| A01 | **Don't build a second YouTube Content ID presence.** The aggregator already holds and delivers the assets. Content ID requires exclusive rights; a duplicate delivery creates reference overlaps, and the first deliverer keeps the claims. Repeated erroneous claims risk termination. **Instead,** use the aggregator's reporting, or renegotiate who administers Content ID. Legal's "start with YouTube" is the trap. | 3 |
| A02 | **You can't crawl the social platforms.** The YouTube Data API allows about 100 searches a day by default, and its terms ban downloading and scraping. TikTok's Research API is academic-only. Instagram's hashtag search is capped at 30 hashtags a week, with no audio. Coverage comes from **registries and vendors**: Audible Magic (free for rights holders), Pex/Vobile registry (free registration), Meta Rights Manager via DDEX, and paid discovery services. | 3 |
| A03 | **Build only where vendors don't reach:** Stage (their own platform), SA-hosted websites, and the matching/case layer. Buy or register for everything else. | 3 |
| A04 | **No automatic takedowns.** Under DMCA §512(f) and ECT Act s77(2), a misrepresented takedown creates liability, and *Lenz* requires a fair-use consideration first. Sample-level matches are research-grade, around 44% mAP for short queries in 2025. So a human confirms every takedown, with a confidence threshold for queueing. Pushing back on the legal head is the executive-presence moment. | 3 |
| A05 | **The fingerprint DB being 40% done is the critical-path dependency.** Phase 0 is to finish or validate it, or to use vendor-side fingerprinting instead. | 2 |
| A06 | **Engine choice by use case:** Chromaprint for exact-duplicate checks; a Panako-class engine for pitch/tempo tolerance (about ±10%, best on 10–20 s queries); vendor engines for UGC scale. Stem/sample detection is a research track with a benchmark, not a promise. | 2 |
| A07 | **Security:** masters never leave the label's environment. Fingerprint locally (vendor local tools such as Audible Magic AMSigGen or ACRCloud's local tool, or on-prem Panako) and send hashes, not audio. Keep unreleased material out of third-party registries until release. Use KMS encryption, least-privilege IAM and an access log. | 2 |
| A08 | **Evidence package per case:** URL, UTC timestamp, SHA-256 of the capture, match offsets and score, reviewer, chain-of-custody log. This aligns with ECT s15(3). It should also note the tension with YouTube's no-storage rule. | 2 |
| A09 | **The cost drivers are scanning, re-querying and vendor fees, not compute.** Fingerprinting the whole catalogue takes about 185 core-hours, which is trivial. The "Remember" dedupe ledger is the main cost control. | 2 |
| A10 | **Storage sizing is roughly right.** About 7,400 hours of audio. 24/96 masters come to about 15 TB, so masters belong in archive tiers (roughly US$15–$350/month depending on tier). Hot storage holds only fingerprints and proxies. | 1 |
| A11 | **Honest vendor pricing.** Most vendors are quote-only (Pex, BMAT, Vobile, and ACRCloud behind a login). AudD publishes about US$5 per 1,000 requests and US$25–45 per stream per month. The R15k/month budget is tested against these explicitly: what it buys, and what it doesn't. | 2 |
| A12 | **Stage is the quick win.** It's the label's own platform, it has full data access, and 300 stem downloads a day is a tractable volume. Options are watermarking or fingerprinting stems at download, plus monitoring for reuse. | 2 |
| A13 | **Phasing with exit and kill criteria.** For example: Phase 1 registers the catalogue with the free registries and builds the Stage + case management layer. Phase 2 adds paid discovery for the open web. Phase 3 is the sample-detection R&D benchmark, killed if precision at the agreed recall stays below X after N weeks. | 2 |
| A14 | **Maintenance is real.** Platform API and policy changes, vendor contract renewals, threshold tuning, false-positive review workload. Costed as people-time, not just infrastructure. | 1 |
| A15 | **Tells the CEO what they can't have:** complete coverage of TikTok/Instagram through the label's own system, reliable automatic detection of short altered samples, and automatic takedowns. | 2 |

**Maximum:** 32 weighted points.

**Red flags (deductions or caps):**
- Proposes building a social-media crawler or a "YouTube scraper". Cap A02 at 0.
- Proposes uploading masters to a vendor without addressing security. A07 = 0.
- Accepts automatic takedowns. A04 = 0, and executive communication is capped at 3.
- Gives a precise vendor price with no source. Penalise under A11.
- A memo that is all diagram and no numbers.

**Internal reference only:** our own proposal priced the build at R525k over 12 weeks and running costs at R20–35k/month. A candidate who lands in the same range with explicit assumptions is credible. A candidate who argues *convincingly* for a cheaper path, for example registries-first with an 80% smaller build, is the kind of thinking we're hiring for. Score their reasoning, not how close they get to our number.

## Rubric (weights)

| Criterion | Weight |
|---|---|
| Answer-key coverage (A01–A15, weighted) | 35% |
| Cost model quality: drivers, assumptions, sensitivity, rand conversion, honesty about unknowns | 20% |
| Security & maintenance depth | 10% |
| Phasing & kill criteria | 10% |
| Executive communication: memo exec summary + Loom (doc 09 §4) | 25% |

Executive communication carries 25% here because this is the test where the engineer has to convince a non-technical CEO and push back on a senior stakeholder.
