# 03: Roles, Competencies, Pay and Adverts

## 1. The delivery unit

```
Client discovery → BA: elicit, profile data, Spiky POV, clickable MVP, handoff pack
                 → SWE: harden, integrate, secure, deploy into the client's environment, operate
                 → BA: adoption, continuous improvement (the SLA analyst)
```

**Where the two roles overlap (deliberately):**
- Data literacy: keys, grain, joins, types, dedupe
- Basic SQL
- Writing acceptance criteria
- Heavy, critical use of AI tools
- Clear executive communication

**Where they split:**
- The **BA owns the problem and the "who can see and do what" access matrix.**
- The **SWE owns the guarantees that implement it:** RLS, migrations, secrets, observability and cost controls.
- **The handoff document is the contract between them**, and it is the most-tested artefact on both sides.

## 2. AI-native Business Analyst

**Mission:** turn ambiguous client problems and messy data into a researched position, a working prototype, and a build-ready handoff. Do not simply transcribe what the client asks for.

**Competencies** (mapped to the IIBA BABOK v3 knowledge areas and underlying competencies):

| # | Competency | What good looks like here | Assessed in |
|---|---|---|---|
| B1 | Elicitation & collaboration | Asks the question that surfaces the hidden constraint. Confirms understanding back. Chooses the right technique. | BA Part 1 persona chat, live elicitation |
| B2 | Data analysis | Finds grain, key, contactability, date and status defects without being told to look | BA Part 1 gap log, role quiz |
| B3 | Research & synthesis | Brings outside evidence (law, platform rules, benchmarks), filters out noise, and connects it to *this* business | Spiky POV |
| B4 | Strategy & judgement | Takes a debatable, evidence-backed position. Says what *not* to build. | Spiky POV, live defence |
| B5 | Solution design & prototyping | Data model with correct grain and keys. A clickable MVP that actually runs on the data. | BA Part 2 |
| B6 | Requirements & handoff | User stories with testable acceptance criteria, business rules, edge cases, an access matrix, out-of-scope | BA Part 2 handoff |
| B7 | Executive communication | Answer first, a crisp structure, numbers, a clear ask | Every written artefact, Loom, live |
| B8 | AI fluency | Uses AI for extraction and drafting, owns the insight, and can say which is which | AI-use note, live defence |

## 3. AI-native Software Engineer

**Mission:** take a BA's prototype and handoff and make it something a client can rely on. Also design, cost and secure larger systems before they are sold.

| # | Competency | What good looks like here | Assessed in |
|---|---|---|---|
| S1 | Production hardening | Finds and fixes RLS gaps, leaked keys, missing migrations and unbounded AI spend *without being told where they are* | SWE Test 1 |
| S2 | Data engineering | Idempotent ingestion, normalisation (E.164, dates), identity resolution, quarantine, loud failure on schema drift | SWE Test 1 (month-2 file) |
| S3 | Full-stack delivery | Implements handoff stories to their acceptance criteria. A working UI. | SWE Test 1 |
| S4 | Deployment & ops | Live URL, CI, health check, error monitoring, rollback note. Uses free tiers resourcefully. | SWE Test 1 |
| S5 | Architecture & judgement | Build vs buy, platform constraints, risks, phasing, kill criteria | SWE Test 2 |
| S6 | Costing | A rand cost model with stated assumptions, volume drivers and sensitivity | SWE Test 2 |
| S7 | Security | Threat model, data minimisation, secrets, least privilege, audit trail | Tests 1 & 2 |
| S8 | AI fluency | Directs AI, verifies its output, can explain every line shipped | Live defence (debugging with AI off) |
| S9 | Executive communication | A one-page exec summary a CEO can decide from. Release notes a client understands. | Test 2 memo + Loom, Test 1 release note |

## 4. Pay and terms (decided)

| | BA | SWE |
|---|---|---|
| Base | **R30,000–R32,500 / month gross** | **R30,000–R32,500 / month gross** |
| Variable | Year-end profit share (discretionary, written policy) | Same |
| Location | Remote within South Africa | Remote within South Africa; **Cape Town or Johannesburg preferred** for in-person client sessions |
| Equity | None at this stage | None at this stage |

**Be honest in the advert.** The market median for a software engineer is roughly R34k–R47k/month (Indeed, Glassdoor), and for a Cape Town BA it is about R44k. This band will attract mid-level, high-aptitude people, not seniors. The pitch has to rest on four things:
1. Learning velocity: real client systems from week one.
2. AI-native ways of working.
3. Profit share.
4. Pay that grows with client revenue.

**Profit share policy.** Write this down before the first offer.
- **Pool:** `[PLACEHOLDER: % of annual net profit, to be decided]`.
- **Eligibility:** employed on 28 Feb and on payment date. Pro-rated for partial years.
- **Discretion clause:** the pool and the individual allocation are discretionary, but are exercised rationally and in good faith. Discretionary bonuses can still be challenged as unfair labour practices (*Apollo Tyres v CCMA*), so apply the policy consistently.
- **Tax:** paid through payroll as an annual payment, so PAYE, UIF and SDL apply.

## 5. LinkedIn advert copy

Wording rules (EEA s6):
- No age, "young/energetic", "native English" or language proxies.
- No "own transport" unless the job requires it.
- State the salary.

### AI-Native Software Engineer: Chase Agents (Remote, South Africa)

> **R30,000–R32,500/month + year-end profit share. Remote within South Africa (Cape Town or Johannesburg preferred for occasional in-person client sessions).**
>
> We build AI automation and operating platforms for mid-market companies: telecoms dealers, music rights holders, financial services. Our business analysts prototype solutions; you make them production-grade and run them.
>
> **You'll:** take working prototypes and harden them (RLS, migrations, secrets, CI, monitoring); build data pipelines that survive messy client exports; deploy into our and clients' clouds; design and cost systems before we sell them; explain all of it clearly to client executives.
>
> **You are:** a full-stack builder (TypeScript, Postgres) who uses AI tools heavily *and* verifies everything they produce. You'd rather ship one thing that works than five that demo.
>
> **Our stack:** Next.js, Vercel, Supabase, OpenRouter.
>
> **How we hire, transparently:** a 15-minute reasoning assessment, a short AI-run CV interview, a 12-minute quiz, then two practical tests (harden-and-ship, and an architecture-and-costing plan). You see your scores at every stage. Shortlisted candidates do a live session with us. We will never use your submissions commercially.
>
> Apply: [link]

### AI-Native Business Analyst: Chase Agents (Remote, South Africa)

> **R30,000–R32,500/month + year-end profit share. Remote within South Africa.**
>
> Our BAs don't just take requirements: they find what the client hasn't noticed, take a position on what will actually move the numbers, and build the first working version.
>
> **You'll:** run discovery with operations teams and executives; dig into messy spreadsheets and system exports to find what's missing; research and form a clear point of view; prototype with AI tools (Lovable, v0, Supabase); hand developers a spec they can build from without asking questions.
>
> **You are:** curious, numerate, comfortable with data, quick with AI tools, and clear in writing. You can tell a CEO "that's the wrong problem" and show why.
>
> **How we hire:** the same transparent process: reasoning assessment, AI CV interview, short quiz, then a discovery-and-point-of-view exercise and a build-and-handoff exercise. Live session for the shortlist.
>
> Apply: [link]

## 6. Minimum hurdles per role (configurable in `roles`)

| Role | Reasoning hurdle | Quiz flag line |
|---|---|---|
| BA | 3★ | < 50% |
| SWE | 3★ | < 55% |

The reasoning hurdle is set around the 40th percentile. It is a **hurdle, not a ranker** (see doc 04 and doc 09).

- A candidate below the hurdle is **queued for admin review**, not rejected automatically.
- The admin can let them through, for example if a strong portfolio offsets the score.
