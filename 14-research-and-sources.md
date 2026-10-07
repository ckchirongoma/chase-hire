# 14: Research and Sources (7 Oct 2026)

This doc summarises the evidence behind each design decision. Re-verify anything marked ⚠ before relying on it.

## Spiky POV and BrainLift

**Wes Kao, "Spiky point of view: Let's get a little controversial" (2020).** A spiky POV is "a perspective others can disagree with… a belief you feel strongly about and are willing to advocate for". Her five criteria:
1. debatable
2. not controversy for its own sake
3. teaches something new
4. rooted in evidence
5. requires conviction

https://www.weskao.com/blog/spiky-point-of-view-lets-get-a-little-controversial

**BrainLift (Alpha School / Trilogy / Crossover).**
- **Structure:**
  - Purpose (in/out of scope)
  - DOK4 Spiky POVs
  - DOK3 Insights
  - Experts
  - Knowledge Tree, with DOK2 summaries and DOK1 facts per source
- **Rule:** "Each layer is supported by the one below it… No unsupported claims."
- **Quality checks:**
  - each SPOV links to 2+ insights
  - no hedging
  - absolutes need an "except when"
  - 7 SPOVs or fewer, with no overlap
  - insights operationalised as "blueprints"
- **Trilogy-affiliated graders** reportedly test DOK4 for "LLM divergence" and "antimemetic" (non-searchable) insight. ⚠ The source is AI-generated docs.

Sources:
- https://github.com/srbdp/brainlift-plugin
- https://github.com/trilogy-group/-brainlift-cli
- https://austinscholar.substack.com/p/austin-scholar-171-my-summer-project
- https://www.forbes.com/councils/forbescommunicationscouncil/2025/12/16/give-your-ai-a-better-brief-why-marketers-need-a-brainlift/

**Counterpoint.** There is a critique of "spiky" in favour of integrating opposing views: https://diffuseattention.substack.com/p/the-spiky-point-of-view-on-spiky. This is why our rubric requires a **steelman**.

## Selection science

**Sackett, Zhang, Berry & Lievens (2022)** revised the validity estimates:

| Method | Validity |
|---|---|
| Structured interview | .42 |
| Job knowledge | .40 |
| Work sample | .33 |
| GMA (cognitive ability) | .31 |
| Unstructured interview | .19 |

Removing GMA from a composite costs only about .05. GMA also has the largest group mean differences.
- https://www.siop.org/tip-article/is-cognitive-ability-the-best-predictor-of-job-performance
- https://master-hr.com/insights/new-study-providing-updated-validity-estimates/

**Panel vs separate interviewers.** Panel interviews show inter-rater reliability of about .74, against .44 for separate interviewers (Huffcutt et al. 2013).

**CCAT benchmark.** 50 items in 15 minutes, average 24/50; fewer than 10% score above 35.
- https://www.criteriacorp.com/files/Criteria-ScoreReportGuide-CCAT.pdf
- https://www.test-guide.com/ccat-practice-test.html

**ICAR** (Condon & Revelle 2014, N≈97k). Mean proportion correct: verbal .64, letter/number series .59, matrices .52, 3D rotation .19. ICAR16 α = .81.
https://personality-project.org/revelle/publications/condon.icar.14.pdf

**Unproctored test verification.** A retest flagged about 14% of test-takers as suspected cheaters (Aguado et al.).
https://www.cambridge.org/core/journals/spanish-journal-of-psychology/article/cheating-on-unproctored-internet-test-applications-an-analysis-of-a-verification-test-in-a-real-personnel-selection-context/110A6CE01AF51A57F429AA6D932AD9C6

**AI-text detectors don't work.** OpenAI's classifier caught 26% of AI text and flagged 9% of human text as AI. Do not use detectors.
https://decrypt.co/149826/openai-quietly-shutters-its-ai-text-classifier-due-to-low-accuracy

## LLM-as-judge

**Zheng et al. 2023 (MT-Bench).**
- GPT-4 agreed with humans 85% of the time; humans agreed with each other 81%.
- Position consistency was only 65%.
- Self-preference was about +10%.
- Reference-guided grading cut maths errors from 70% to 15%.

https://arxiv.org/html/2306.05685v4

**Other findings:**
- **G-Eval:** judges show a bias toward LLM-written text. https://huggingface.co/papers/2303.16634
- **Prometheus:** using a rubric plus a reference answer gave Pearson .897 against human scores. https://arxiv.org/abs/2310.08491v2
- **Pairwise vs pointwise:** pairwise judgements flipped about 35% of the time under distractor features, pointwise about 9%. https://arxiv.org/abs/2504.14716v1
- **Agreement metrics:** use kappa or ICC, not percent agreement. https://arxiv.org/abs/2406.12624v1
- **ICC thresholds** (Koo & Li 2016): below .50 poor, .50–.75 moderate, .75–.90 good, above .90 excellent.
- **Prompt injection in documents** is real: hidden prompts were found in arXiv papers. https://www.techrepublic.com/article/news-hidden-ai-prompts-academic-research-papers/

## Executive communication

- **Minto Pyramid / SCQA:** https://thinkinsights.net/strategy/pyramid-principle
- **BLUF:** https://en.wikipedia.org/wiki/BLUF_(communication)
- **Amazon narrative memos:** https://www.cnbc.com/2018/04/23/what-jeff-bezos-learned-from-requiring-6-page-memos-at-amazon.html
- **Hewlett, executive presence:** gravitas 67%, communication 28%, appearance 5% (survey perception data). https://tandemcoach.co/sylvia-hewlett-executive-presence/

## AI-native hiring practice

**Canva** runs AI-assisted coding interviews built around realistic, ambiguous problems. Strong candidates clarify requirements first and verify the AI's output. Three failure modes: "AI Showcase", "Feature Marathon", "Hands-Off".
- https://canva.dev/blog/engineering/yes-you-can-use-ai-in-our-interviews
- https://www.canva.dev/blog/engineering/ai-interview-success/

**Meta** runs an AI-enabled 60-minute round in an existing multi-file codebase: fix a bug, build a feature, then optimise. https://www.hellointerview.com/blog/meta-ai-enabled-coding

**Shopify:** "reflexive AI usage is a baseline expectation"; candidates bring their own tools. https://www.hellointerview.com/blog/shopify-ai-enabled-coding

**PostHog** runs a paid full-day build that is too big to finish, with AI allowed. AI is then banned in the debugging session, and candidates must defend their architecture. https://posthog.com/handbook/people/hiring-process/engineering-hiring

**Anthropic** takes the opposite approach: no AI in take-homes or live interviews unless stated. https://www.anthropic.com/candidate-ai-guidance

**Take-home length.** Over 80% of engineers want 4 hours or less, and the average completion rate is about 62%. 58% think take-homes should be paid; 4% are.
https://interviewing.io/blog/why-engineers-dont-like-take-homes-and-how-companies-can-fix-them

## Supabase / Next.js production readiness

**Supabase production checklist:** RLS everywhere, SSL, network restrictions, MFA, custom SMTP, PITR once the database passes 4 GB. https://supabase.com/docs/guides/deployment/going-into-prod

**RLS and default grants.** New `public` tables get grants for `anon` and `authenticated`, and adding policies does not revoke those grants. https://supabase.com/docs/guides/database/postgres/row-level-security

**Secret keys bypass RLS** and must never reach the browser. https://supabase.com/docs/guides/api/api-keys

**Database advisors and their lint codes:** https://supabase.com/docs/guides/database/database-advisors

**`NEXT_PUBLIC_` variables are inlined into the JavaScript bundle.** https://nextjs.org/docs/app/guides/environment-variables

**Secret scanning:** gitleaks https://github.com/gitleaks/gitleaks

**MDN HTTP Observatory API** for security headers: https://developer.mozilla.org/en-US/observatory/docs/faq

## Free tiers (for candidates)

- **Vercel Hobby:** non-commercial use only. A candidate's own take-home is fine. https://vercel.com/docs/plans/hobby
- **Supabase Free:** 500 MB database. Projects pause after about a week of inactivity, so review submissions promptly. https://supabase.com/pricing
- **Cloud Run always-free tier:** 2M requests a month. A billing account is needed, and the GCP trial requires a card. https://cloud.google.com/run/pricing and https://docs.cloud.google.com/free
- **Lovable:** free tier works with Supabase. https://docs.lovable.dev/integrations/supabase.md
- **v0:** 7 messages a day on the free tier. https://v0.app/pricing
- **Bolt:** connecting Supabase requires Pro.
- **Claude Code:** not available on the free plan.

## Salaries (South Africa, monthly gross)

| Source | Role | Figure |
|---|---|---|
| Glassdoor | Software engineer | Median R42k (25th–75th percentile R32k–R55k) |
| Indeed (Sep 2026) | Software engineer | Average R34,006; junior about R20k; senior about R58k |
| Indeed | Full-stack developer | Average R47,438; Cape Town R53,298 |
| Glassdoor | Business analyst, Cape Town | Median R44k (25th–75th percentile R30k–R58k) |

Sources:
- https://www.glassdoor.com/Salaries/south-africa-software-engineer-salary-SRCH_IL.0,12_IN211_KO13,30.htm
- https://za.indeed.com/career/software-engineer/salaries
- https://za.indeed.com/career/full-stack-developer/salaries
- https://www.glassdoor.com/Salaries/cape-town-business-analyst-salary-SRCH_IL.0,9_IM1026_KO10,26.htm

## SA law

**EEA s8 as amended.** HPCSA certification for tests was deleted from 1 January 2025.
- https://www.acts.co.za/employment-equity-act/8__psychological_testing_and_other_similar_assessments.php
- https://www.cliffedekkerhofmeyr.com/en/news/publications/2023/Practice/Employment/employment-law-alert-17-april-QA-on-the-employment-equity-amendment-.html

**ATP v President of RSA (2017):** https://www.saflii.org/za/cases/ZAGPPHC/2017/144.html

**HPCSA GNR 993 (2008):** the psychology scope-of-practice regulation. ⚠ How it applies to custom employer tests is untested. https://www.hpcsa.co.za/Uploads/professional_boards/psb/regulations/regulations_gnr993_2008.pdf

**POPIA:**
- s71 automated decisions: https://bowmanslaw.com/insights/south-africa-ai-in-the-workplace-2-of-6-popia-considerations/
- s69 and the December 2024 direct-marketing guidance note: https://www.cliffedekkerhofmeyr.com/en/news/publications/2025/Sectors/Technology-Communications/Technology-and-Communications-Alert-29-january-Navigating-the-Information-Regulators-guidance-note-on-direct-marketing

**CPA opt-out registry regulations (from 15 April 2026):** https://www.golegal.co.za/cpa-amendment-regulations/ (⚠ monthly cleansing frequency not confirmed)

**WhatsApp opt-in and pricing:**
- https://developers.facebook.com/documentation/business-messaging/whatsapp/getting-opt-in.md
- https://developers.facebook.com/docs/whatsapp/pricing
- ⚠ Service-message charges from 1 October 2026 are reported by secondary sources only.

**Profit-share bonuses:**
- Discretionary bonuses are still subject to unfair labour practice rules: https://www.cliffedekkerhofmeyr.com/en/news/publications/2018/Employment/employment-alert-28-november-are-companies-liable-by-law-to-pay-their-employees-bonuses.html
- Bonus taxed through PAYE as an annual payment: https://www.sars.gov.za/paye-gen-01-g20-guide-for-employers-iro-employees-tax-for-2026-external-guide

## Catalogue protection (SWE Test 2 answer key)

**YouTube Content ID**
- Eligibility requires exclusive rights: https://support.google.com/youtube/answer/1311402
- Reference overlaps are resolved in favour of whoever delivered first: https://support.google.com/youtube/answer/3022604

**Free registries for rights holders**
- Audible Magic: https://support.audiblemagic.com/benefits-of-registering-your-content-with-audible-magic-1
- Pex/Vobile (acquired April 2025): https://pex.com/products/attribution-engine/

**Published pricing benchmark.** AudD: about US$5 per 1,000 requests; US$25–45 per stream per month. https://www.audd.io/

**ACRCloud** does not publish prices.

**Platform API limits**
- YouTube Data API quotas: about 100 searches a day by default. Its terms also ban downloading. https://developers.google.com/youtube/v3/determine_quota_cost
- TikTok Research API is academic-only: https://developers.tiktok.com/products/research-api
- Instagram hashtag search: 30 hashtags per 7 days. https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/hashtag-search

**Matching engines**
- Panako handles pitch and tempo changes of about ±10%: https://archives.ismir.net/ismir2021/latebreaking/000039.pdf
- Chromaprint matches whole songs only, not snippets: https://en.wikipedia.org/wiki/AcoustID
- Sample identification state of the art is about 44% mAP (ISMIR 2025): https://arxiv.org/abs/2506.14684

**Takedown law**
- ECT Act s77 (with s77(2) liability for wrongful takedown): https://www.polity.org.za/polity/govdocs/legislation/2002/act25.html
- DMCA §512(f) misrepresentation liability: https://www.law.cornell.edu/uscode/text/17/512
- *Lenz v Universal* (fair use must be considered before a takedown): https://copyrightalliance.org/copyright-cases/lenz-v-universal-music

**Storage pricing**
- S3: https://aws.amazon.com/s3/pricing/
- GCS: https://cloud.google.com/storage/pricing
