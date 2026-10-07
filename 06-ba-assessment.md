# 06: BA Assessment

There are two online parts and one live part. All data is **synthetic**: see doc 11. The client in every brief is fictional:

- **Kopano Connect**, a business-mobile dealer for "the Network" (a national mobile operator)
- **Virtual Sales (VSAM)**, the channel that renews and upgrades contracts for existing SME customers by phone

The scenario mirrors a real engagement. No real names, numbers or brands are shown to candidates.

## Part 1: Discovery, gaps and Spiky POV

**Work window:** 4 hours from Start, intended effort about 3 hours. The open window is 7 days.

### Candidate brief (render verbatim in the platform)

> **Client:** Kopano Connect, a mobile network dealer. Their Virtual Sales team phones existing business customers to renew and upgrade contracts.
>
> **The ask, from their GM Virtual Sales:** *"Automate our renewal outreach. WhatsApp, SMS and email, starting three months before each contract ends, and give my agents one view per customer."*
>
> **You have:**
> 1. `kopano_vsam_extract.xlsx`, containing four sheets:
>    - the monthly customer base export
>    - one agent's working sheet
>    - telephony stats for last month
>    - the team's daily activity log
> 2. **A 25-minute chat with Lerato Dube, GM Virtual Sales** (the "Interview the client" tab). She is busy and answers what you ask, not what you should have asked. You can send up to 25 messages. The chat is logged and assessed.
> 3. The open internet. AI tools are allowed and expected.
>
> **Deliver one document (PDF or DOCX, max 1,500 words excluding appendices):**
> 1. **Executive summary** (≤150 words): your recommendation and the decision you need from Lerato.
> 2. **Purpose:** the business question, and what is in and out of scope.
> 3. **Facts:** the specific, verifiable things you found, each cited to sheet/column or to the interview.
> 4. **Insights:** the patterns that are *not* obvious. Each one should connect two or more facts or sources.
> 5. **Spiky POV:** one to three positions a reasonable person could disagree with. For each:
>    - the evidence
>    - the strongest counter-argument
>    - why it loses here
> 6. **Solution:** what to build first, what to fix before building, and what *not* to build.
> 7. **Success criteria:** for each, give the metric, the baseline from the data, the target, the timeframe, and **the result that would prove you wrong**.
> 8. **AI-use note** (≤100 words): what AI did for you, and what you did yourself.
>
> **Appendix A: Gap log.** A table with these columns: Gap | Evidence (sheet/column/row count) | What it blocks | Severity (Critical/High/Medium/Low) | Proposed fix.
>
> **Appendix B: Questions.** The questions you would still ask, and who you would ask.
>
> **How you'll be assessed:**
> - what you found
> - what you got out of the client
> - how well your point of view is argued and evidenced
> - whether your success criteria are measurable
> - how clearly you write for an executive
>
> **Note:** we will not use your work commercially, and you keep copyright.

### The stakeholder persona (AI, OpenRouter)

- **Persona:** Lerato Dube, GM Virtual Sales, Kopano Connect.
- **Personality:**
  - Competent, time-poor, mildly impatient.
  - Wants sales, not dashboards.
  - Talks in outcomes.
  - Has strong opinions: "WhatsApp is the answer."
  - Will push back once if the candidate challenges her.
  - Respects candidates who bring numbers.
- **Mechanics:**
  - Each reply returns `{reply, revealed_fact_ids[]}`.
  - A fact is "revealed" only when the candidate's question targets its trigger topic. Vague questions get vague answers.
  - The persona never volunteers a hidden fact unprompted, with one exception: H12 (the target) comes out the first time sales are mentioned.
- **Message cap:** 25 candidate messages. The persona closes politely at the cap or when the time window ends.

**Hidden facts.** These double as the answer key for "elicitation yield". Weight 3 = critical, 2 = important, 1 = useful.

| ID | Fact (persona's words) | Trigger topics | Wt |
|---|---|---|---|
| H01 | "Customer contact details? The agents keep those in their own sheets. The base from the Network doesn't have them." | where contacts come from; how agents reach customers; phone/email source | 3 |
| H02 | "The base is a monthly Power BI export from the Network. We can't change its columns, we just get what we get." | data source; refresh; who owns the extract | 2 |
| H03 | "Technically the customer data is the Network's. Our dealer agreement lets us contact them about Network products, renewals and upgrades." | data ownership; permission to contact; legal basis; dealer agreement | 3 |
| H04 | "Legal keeps an opt-out and 'under legal review' list in a separate spreadsheet. It's by company name, not account number." | opt-outs; do-not-contact; complaints; legal | 3 |
| H05 | "The dialler has no API. They said they can do a nightly CSV export and they connect to Power BI." | telephony; call data; integrations; dialler | 2 |
| H06 | "The WhatsApp and SMS platform is the Network's. Templates need their approval; last time it took about a week." | messaging platform; WhatsApp setup; sender; templates | 2 |
| H07 | "Customers can upgrade from three months before contract end, but a few price plans only allow it in the last month." | eligibility; upgrade rules; when can they renew | 2 |
| H08 | "Agents earn commission per upgrade, so honestly they don't love sharing their sheets." | incentives; why data isn't shared; agent behaviour; commission | 2 |
| H09 | "The contract status column is whatever it was on the day the Network ran the report." | data freshness; status accuracy; how status is calculated | 2 |
| H10 | "One account manager owns the entire base. If he's on leave, nothing moves." | ownership; who manages accounts; escalation | 1 |
| H11 | "We did a bulk SMS blast last year. We got complaints, and the Network threatened to suspend our sender." | past attempts; what went wrong; complaints; history | 3 |
| H12 | "My target is to double upgrades per month. I don't need another dashboard." | goals; success; targets; KPIs (volunteered when sales are mentioned) | 1 |
| H13 | "Half the time the contact person is a bookkeeper or receptionist, not the person who decides." | who you talk to; decision makers; contact quality | 2 |
| H14 | "Lines that port out just vanish from the next month's base. Nobody tells us." | churn; lines disappearing; month-to-month changes | 2 |

**Maximum elicitation yield:** 30 weighted points.

### Gap answer key (D-codes match doc 11's planted defects)

The grader maps each gap-log row and memo claim to these IDs. Partial credit applies for a correct gap with weak evidence.

| ID | Gap | Severity | Weight |
|---|---|---|---|
| D01 | No customer-level key; the base is at line grain (MSISDN); "customer" = account no., with no company reg. number | Critical | 3 |
| D02 | No contact channels (phone, email, WhatsApp) in the base. Only about 9% of accounts have any contact data, held in the agent sheet | Critical | 3 |
| D03 | Same company under multiple accounts; name variants | High | 2 |
| D04 | Agent-sheet accounts missing from the base | Medium | 1 |
| D05 | Phone formats inconsistent: leading zero stripped, `0` placeholders, landlines mixed in. Not E.164; can't be used for WhatsApp/SMS | Critical | 3 |
| D06 | Account holder name `0` (blank stored as zero); emails missing | High | 2 |
| D07 | Mixed types in the contact column | Low | 1 |
| D08 | `date contacted` in mixed and impossible formats (US, ambiguous, YYYY/DD/MM, month 13) | High | 2 |
| D09 | Fractions auto-converted to dates (`3/4` → 4 March) | Medium | 1 |
| D10 | Epoch placeholder end dates (1970-01-01) | Medium | 1 |
| D11 | Status contradicts end date: "InContract" lines that have already expired | High | 2 |
| D12 | "Months remaining" is a text bucket, so it can't drive a 90-day rule | Medium | 1 |
| D13 | Free-text outcomes, a headerless notes column, a bolted-on "clean" column | Medium | 1 |
| D14 | Next Action / Action Required 100% empty; callbacks with no date | Critical | 3 |
| D15 | Quote requests don't flow to applications; no pipeline linkage | High | 2 |
| D16 | Meaningless status field ("DONE" on everything) | Low | 1 |
| D17 | Hand-maintained counts drift from the base | Medium | 1 |
| D18 | Constant columns; misspelt manager name | Low | 1 |
| D19 | Telephony is aggregate only: no per-call, customer or timestamp data; no API | High | 2 |
| D20 | Agent identity not reconciled across systems; test/system users present | Medium | 1 |
| D21 | Activity log issues: packed target string, trailing-space headers, booked-off days counted as zero | Low | 1 |
| D22 | Funnel: the conversion collapse is between connected and opportunity, so this is a process problem, not only a tooling problem | High | 2 |
| D23 | No consent / opt-out flag in the base; POPIA s69 basis unclear | Critical | 3 |

**Maximum gap recall:** 39 weighted points.

**What "great" looks like.** The candidate realises that the client's ask, *automated omnichannel outreach*, is **blocked** by D01 + D02 + D05 + D23 + H03 + H04 + H11. Automating outreach to an uncontactable, consent-unclear base risks the sender account and the dealer agreement. A great memo reframes the problem as **contactability + next-action discipline first, channels second**. See doc 13.

### Rubric: Part 1

Full anchors are in doc 09.

| Criterion | Weight |
|---|---|
| Gap recall (weighted, from the key above) | 25% |
| Elicitation yield (weighted hidden facts, plus quality of questioning) | 20% |
| Spiky POV quality (7 sub-criteria, doc 09 §3) | 25% |
| Success criteria (baseline, target, timeframe, kill condition) | 10% |
| Research quality and relevance (POPIA s69, WhatsApp rules, CPA opt-out registry, benchmarks; sourced; filtered) | 10% |
| Executive communication (doc 09 §4) | 10% |

## Part 2: Build and handoff

**Work window:** 48 hours from Start, intended effort about 4 hours.

**Unlock condition:** Part 1 is submitted **and** an admin has advanced the candidate.

### Candidate brief

> Lerato has accepted a solution direction. We've attached:
> - the **Solution Brief**, a one-page summary of the agreed approach
> - a **cleaned dataset**: customers, accounts, lines, contact points with consent flags, agents, normalised dates
>
> Your job is to show us the first working version and hand it to our engineer.
>
> **Deliver:**
> 1. **Data model:**
>    - an ERD (image or Mermaid)
>    - table definitions: name, purpose, columns, types, keys
>    - the grain of each table, in one sentence
> 2. **Clickable MVP, hosted, running on the provided data.** Use any free tool. Lovable or v0 with Supabase both work on free tiers. It must include:
>    - **Renewal queue:** lines and customers entering the 90-day window, prioritised, with eligibility rules applied
>    - **Customer 360:** accounts, lines, contact points + consent, interaction history
>    - **Log outcome:** a callback date is **required** for "Call back"; quote, sale and not-interested outcomes all available
>    - **Message:** compose from an approved template, blocked if there's no consent or the customer has opted out; queued, not actually sent
>    - **Manager exceptions view:** missing next actions, overdue callbacks, customers with no valid contact point
> 3. **Handoff pack for the engineer** (DOCX/PDF/MD) using our template:
>    - the problem and the POV in 5 lines
>    - user stories with Given/When/Then acceptance criteria
>    - business rules (eligibility, consent, allocation, deduplication)
>    - an **access matrix**: role × action (agent, manager, admin)
>    - edge cases
>    - non-functional needs
>    - out of scope
>    - open questions
> 4. **A 5-minute Loom demo, addressed to Lerato.** What it does, what it doesn't, and the decision you need from her.
>
> **Note:** we will not use your work commercially, and you keep copyright.

### Solution Brief (given to candidates; a condensed version of doc 13's direction)

> **Agreed direction:** fix contactability and next-action discipline before automating channels. Phase 1 is a Renewal Desk:
> - one customer record
> - verified contact points with a consent status
> - a 90-day renewal queue
> - mandatory dated next actions
> - template messaging only to consented, contactable customers
> - a manager exceptions view
>
> Bulk outreach is out of scope until the contactable share passes 60%.

### Rubric: Part 2

| Criterion | Weight | Evidence |
|---|---|---|
| Data model correctness (grain, keys, consent modelled per contact point, history as events, no line/customer confusion) | 25% | ERD + definitions |
| MVP functionality vs required features (an automated click-through plus human check) | 25% | MVP URL snapshot + Loom |
| Handoff quality: testable ACs, rules, access matrix, edge cases. Test: *could the engineer build without asking?* | 30% | Handoff pack |
| Executive communication (Loom to Lerato) | 10% | Loom |
| Judgement: what they left out and why | 10% | Handoff "out of scope" + Loom |

## Live stage (BA shortlist)

1. **Structured panel interview** (30 min): behavioural questions + probes from the AI interview's verification concerns. Anchored scorecard (doc 09 §5).
2. **Live defence** (20 min): the panel challenges their Spiky POV with unseen counter-evidence. For example: *"Lerato says the Network will supply phone numbers next quarter. Does your POV still hold?"* Score composure, and whether they update their view for a stated reason or defend it with evidence (doc 09 §4, items 7–8).
3. **Live elicitation role-play** (25 min): a **new** scenario played by a human, for example a music label's royalty team that "wants a dashboard". There are 8 hidden facts. Score technique choice, probing, confirming back, and yield.
4. **Reasoning retest:** parallel form, 12 items in 6 minutes.
