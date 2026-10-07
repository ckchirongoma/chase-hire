# 12: Compliance (South Africa)

Based on research done on 7 Oct 2026. This is not legal advice; have an employment/privacy lawyer review it before launch.

## 1. POPIA

**Information officer**
- By default, the information officer is the head of the business (Charles).
- **Register with the Information Regulator before processing.**
- Publish a PAIA manual.
- Do a short personal information impact assessment of this platform.

**Lawful basis and notice (s18)**
- The basis is steps towards a contract at the candidate's request, with consent as a backup.
- The consent screen at `/consent` (versioned, stored in `consents`) must state:
  - what we collect: identity, contact details, CV, assessment responses, chat transcripts, interaction signals
  - why we collect it: assessing suitability for the role applied for
  - **that AI is used** to parse CVs, run the screening interview and grade work, **and that humans make every decision**
  - **offshore processing (s72):** LLM providers via OpenRouter, and where they are located. Get consent and use providers with adequate safeguards; prefer zero-retention routing.
  - **retention:** unsuccessful candidates' data is deleted or de-identified **6 months** after the round closes, unless they opt into the talent pool (separate checkbox, 12 months)
  - their rights: access, correction, objection, and **to request human review of any score**
  - CV dedupe, and why we do it
- **Special personal information.** Do not collect race, religion, health, etc. in the main flow. If we monitor adverse impact, collect demographics through a separate, optional, consented form stored apart from assessment data.

**Automated decisions (s71)**
- No decision is based *solely* on automated processing. Enforcement points:
  - all advance and reject transitions go through an admin action with a reason (`decisions` table)
  - batch-advance requires explicit admin confirmation
  - there are **no automated rejections**
- Candidates receive the scored factors (results page) and can make representations (`review_requests`).
- The notice explains "the underlying logic" in plain language: which stages are scored, how, and how much each one weighs.

**Retention automation**
- A nightly job moves closed applications into `retention_queue`.
- Purged data covers CVs, transcripts, submissions and snapshots.
- **Keep:** anonymised item-level statistics, plus aggregated validation and adverse-impact data. Advisers suggest keeping selection decision records for about 3 years in case of disputes; keep a minimal decision log keyed by a hashed ID.

**Operators**
- Supabase, Vercel, OpenRouter and the underlying model providers are operators.
- Keep their DPAs/terms on file.

## 2. Employment Equity Act

**s6 (unfair discrimination)**
- Applies to all employers, and to applicants.
- Advert and assessment wording must avoid proxies such as age, language, "native English" and family-responsibility burdens.
- Long unpaid tasks may disadvantage applicants with caregiving duties. That is why our windows are long and flexible, and the effort is capped.

**s8 (psychological testing and similar assessments)**
- Assessments must be valid, reliable, fairly applied and not biased.
- HPCSA certification is no longer required under s8 (deleted from 1 Jan 2025).
- s8 still covers "other similar assessments". That likely includes our reasoning test, and arguably the AI interview and AI grading.

**Our controls**
- Each assessment is job-related, with a documented rationale (docs 03–08).
- Administration is standardised.
- Grader calibration evidence is kept (doc 09 §8).
- Item statistics and KR-20 are tracked.
- An adverse-impact report runs every cohort.
- No hard auto-cutoffs.

**HPCSA scope-of-practice regulation (GNR 993/2008)**
- The rule:
  - Reserves the use and development of tests of "intellectual abilities, aptitude… personnel career selection" for psychologists.
  - How this applies to custom tests built by non-psychologists is untested.
- Our mitigation:
  - Call the test a *job-related* "Reasoning Assessment".
  - Keep its weight low and use it as a hurdle.
- **Decided (7 Oct 2026):** we use our own in-house assessment, with no psychologist review and no licensed test. We accept the residual risk, and the mitigations above stay in place.

**Designated employer status:** 50+ employees from 1 Jan 2025. We are below that, so there are no EE plan or report duties, but s6 and s8 still apply.

## 3. Work samples, copyright and fairness

Every brief states:
- the intended effort and the window
- that **the candidate keeps copyright**
- that **Chase Agents will not use submissions commercially**
- that all data is synthetic

Without a written assignment, a non-employee's code belongs to its author, so commercial use would be legally risky as well as unethical.

**Suggested stipend:** R2,000 for shortlisted finalists who complete the live stage. This acknowledges the time investment. The amount is Charles's call.

## 4. Profit share

Write the policy before the first offer:
- the pool
- eligibility
- pro-rating
- a discretion clause, exercised rationally and in good faith

Payment goes through payroll as an annual payment, subject to PAYE (plus UIF and SDL).

## 5. Assessment content that touches law

The BA scenario intentionally involves direct marketing. The answer key rewards candidates who identify the following.

**POPIA s69:**
- Electronic direct marketing requires opt-in consent unless the **s69(3) existing-customer exception** applies.
- The exception needs all of these:
  - the details were obtained in a sale
  - the marketing is for the business's *own similar* products
  - the customer was offered an opt-out at collection **and** in every message
- The dealer-vs-network data ownership question (H03) directly affects whether the dealer can rely on s69(3).

**Consent requests:** a request for consent can be made only once (Form 4). Telemarketing calls count as direct marketing under the Regulator's December 2024 guidance note.

**CPA s11 opt-out registry:**
- National Consumer Commission regulations have been in effect since 15 April 2026.
- The CPA protects juristic persons only below **R2m turnover**, which covers many SMEs in a dealer's base.
- Marketers must suppress against the registry.

**WhatsApp Business Platform:**
- Explicit opt-in naming the business is required.
- Outside the 24-hour customer-service window, only pre-approved templates can be sent.
- Pricing is per message, by category, and billed in USD:
  - SA marketing about US$0.038 (about R0.62)
  - utility about US$0.008 (about R0.12)
- Several sources report that service messages are charged from 1 October 2026. Verify against Meta's live rate card.
