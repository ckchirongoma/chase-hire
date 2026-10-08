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

## 5. Job descriptions and LinkedIn posts

**The full job descriptions live in the database** (`roles.jd_md`, seeded by migration 0020) and show on `/roles/<slug>`. Edit them at `/admin/roles`; the role page has the Apply button directly underneath. `roles.spec_md` stays the short, factual spec the AI interviewer reads, so rewriting the job description never changes interview behaviour.

Every version (site, LinkedIn, anywhere else) speaks to the reader in the same voice:
- second person, plain words, no recruitment clichés;
- what the work actually is, including a typical day (described by part of the day, never fixed times, so it doesn't promise a schedule);
- what great looks like, who the job is for, and who it isn't for;
- honest about the pay band;
- the hiring process with its real times;
- then an invitation to apply.

Wording rules (EEA s6, docs/12):
- No age or age proxies ("young", "energetic", "digital native", "recent graduate", experience caps). "AI-native" is defined in the copy as a way of working, not an age.
- No "native English" or other language proxies.
- No "own transport" unless the job requires it.
- "Not for you if" describes how someone wants to work, never who they are or their circumstances.
- State the salary.
- No assessment spoilers: describe skills generally, never the planted defects, rubric details or datasets.

### LinkedIn: AI-native Business Analyst

```text
R30,000–R32,500 a month gross + year-end profit share. Remote within South Africa.

Most business analyst jobs end with a document. This one ends with something that works.

At Chase Agents you'll sit with a client's team, dig through their spreadsheets and system exports, and work out what's really going on. It's often not what they asked about. You'll take a position on what to build, back it with research, and then build the first clickable version yourself with AI tools. When it proves the point, you hand it to one of our engineers, who takes it to production. Your handoff is what they build from, so it has to be good enough that they don't need to call you.

A typical day: a call where the useful answer comes from your fourth question, an afternoon in a messy export finding what's broken before anyone tells you where to look, a screen added to the prototype so the client can see it work on their own data, and two new acceptance criteria in the handoff.

This is for you if:
- you'd rather find out what's actually wrong than write down what you're told
- you open the spreadsheet before the meeting and notice when the numbers don't add up
- you can tell a senior person "that's the wrong problem" and show them why
- you use AI tools every day and check what they give you
- you want to build things, even if you've never called yourself a developer

It's not for you if you want a clear spec handed to you, you'd rather not build anything yourself, or you want to hand over a document and move on. And if you need a senior salary right now: our band is below the market rate for senior BAs, and we'd rather say so up front. What comes with it: real client systems from week one, an AI-native way of working, a share of the profit, and room to grow.

How we hire, all online, and you see your result after every stage: a 15-minute reasoning assessment, a spoken AI conversation about your CV, a 12-minute quiz, a discovery-and-point-of-view exercise, a build-and-handoff exercise, then a live session if you're shortlisted. People make every decision. We never use your work commercially.

The full role, including what a day looks like and what great looks like: [link]
```

### LinkedIn: AI-native Software Engineer

```text
R30,000–R32,500 a month gross + year-end profit share. Remote within South Africa (Cape Town or Johannesburg preferred for occasional in-person client sessions).

Our business analysts build the first version of a client's system with AI tools, quickly. It works on their laptop and proves the idea. Your job is to make it something a client can rely on.

At Chase Agents you'll read code you didn't write, find what will break before it breaks, fix what matters first, and put it into production. You'll build imports that survive messy client data, implement the BA's handoff to its acceptance criteria (and tell them when it's wrong), and design and cost bigger systems in rands before we sell them. Our stack: TypeScript, Next.js, Vercel, Supabase, OpenRouter.

A typical day: a prototype lands with its handoff pack and by mid-morning you have a list. You fix the worst problem first and write the test that would have caught it. AI drafts the migration and you read every line. A call with the BA turns "managers see everything" into a rule you enforce in the database, not just on the screen. You deploy to staging and write release notes a client's operations manager will actually understand.

This is for you if:
- you'd rather ship one thing that works than five that demo
- you use AI tools every day and verify what they produce
- you enjoy making someone else's working idea solid, not only starting from a blank page
- you care about security and data handling because you know what happens when they go wrong
- you can explain a trade-off to a non-technical executive, with numbers

It's not for you if you only want greenfield work, you'd rather rewrite than understand, or you'd rather not talk to clients. And if you need a senior salary right now: our band is below the market median for senior engineers, and we'd rather say so up front. What comes with it: production responsibility on real client systems from week one, an AI-native way of working, a share of the profit, and room to grow.

How we hire, all online, and you see your result after every stage: a 15-minute reasoning assessment, a spoken AI conversation about your CV, a 12-minute quiz, a harden-and-ship test (about 6 hours in a 72-hour window), an architecture and cost plan, then a live session if you're shortlisted. People make every decision. We never use your work commercially, and you keep the copyright.

The full role, including what a day looks like and what great looks like: [link]
```

## 6. Minimum hurdles per role (configurable in `roles`)

| Role | Reasoning hurdle | Quiz flag line |
|---|---|---|
| BA | 3★ | < 50% |
| SWE | 3★ | < 55% |

The reasoning hurdle is set around the 40th percentile. It is a **hurdle, not a ranker** (see doc 04 and doc 09).

- A candidate below the hurdle is **queued for admin review**, not rejected automatically.
- The admin can let them through, for example if a strong portfolio offsets the score.
