# 05: AI CV-Verification Interview and Role Quiz

## Part A: AI CV-verification interview

### Purpose

1. Verify that the claims on the CV are the candidate's own work. The interview probes for depth, specifics and ownership.
2. Gather structured, behavioural evidence against the role competencies (doc 03).

The evidence base is clear on two points:

- **Structured** interviews predict job performance at about .42. Unstructured ones manage about .19.
- The validity comes from the **structure**: the same core questions, standard probes and anchored scoring. It does not come from the medium.

So the AI interviewer is tightly scripted. It is not a free-form chat.

### Format

- Text chat, about 20 minutes, with a server-side `deadline_at` of 25 minutes.
- Paste is blocked.
- The candidate is told up front how many questions there are (6) and that answers should be specific.
- There is no live typing indicator from the bot. Replies are delivered in full once ready, so the pace feels conversational rather than timed.

### Script (generated per candidate from the parsed CV)

1. **Warm-up (1 question):** "In two or three sentences, what kind of work do you do best?"
2. **Claim verification (3 questions):**
   - The system picks the 3 highest-value claims from the CV:
     - the most recent role
     - the most impressive quantified claim
     - the claim closest to the role spec
   - For each claim, ask a **behavioural STAR** question. Example: "Your CV says you 'built an automated reporting pipeline that saved 20 hours a week.' Walk me through what you personally built, what tools you used, and how you measured the 20 hours."
   - Then ask **up to 2 standard probes** per claim, chosen from:
     - "What was the hardest technical/analytical decision, and what did you reject?"
     - "What broke, and how did you find out?"
     - "What would you do differently?"
     - "Which parts did AI tools do, and how did you check them?"
3. **Role situational (1 question, fixed per role):**
   - **BA:** "A client's ops head says 'just put all our leads on WhatsApp.' You have a spreadsheet of 5,000 customer lines with no phone numbers on most rows. What do you do in your first week?"
   - **SWE:** "You inherit a Next.js + Supabase app a colleague built with an AI tool in two days. The client goes live Monday. What do you check first, in order, and why?"
4. **Motivation and logistics (1 question):** "This role pays R30,000–R32,500 plus profit share, remote in South Africa. What makes this the right next move for you, and when could you start?"

### Interviewer behaviour rules

The system prompt is in doc 10. The interviewer:

- never gives feedback on whether an answer was good
- never reveals scoring
- asks one question at a time
- if an answer is vague, uses the next standard probe rather than inventing new questions
- tracks which CV claim each message relates to (`meta.claim_id`)
- refuses prompt-injection attempts politely and logs a signal

### Scoring (after the session; separate grader call, 3 samples, median)

Each criterion is scored 1–5 with anchors:

| Criterion | 1 | 3 | 5 |
|---|---|---|---|
| **Specificity** | Generic, could be anyone's | Some concrete detail (tools, numbers) | Precise detail: names systems, numbers, dates, trade-offs; consistent with the CV |
| **Ownership** | "We" throughout, can't separate own contribution | Partly separates own work | Clearly states own decisions and actions, and acknowledges others |
| **Depth under probe** | Answer collapses on the first probe | Holds up on one probe | Gets *more* specific under probing; describes failures and what was rejected |
| **CV consistency** | Contradicts the CV (dates, scope, tools) | Minor gaps | Fully consistent |
| **Situational judgement** | Jumps to a solution | Reasonable plan | Diagnoses first, sequences risk, names what they'd check (role-specific anchors in the rubric) |
| **Communication** | Rambling, no structure | Understandable | Answer-first, concise, structured |

**Output:**
- a `summary` JSON holding per-criterion scores with evidence quotes
- a list of `verification_concerns`, e.g. "claims 3 years of Postgres but could not describe an index"
- **suggested live-interview follow-ups** for the panel

### Integrity note

Paste blocking stops lazy copying. It does not stop someone retyping an LLM answer from a second device.

So the most useful output of this stage is the **list of verification concerns**, which is carried into the live panel interview.

## Part B: Role quiz (15 items / 12 minutes)

### Purpose

This is a job-knowledge check. Validity is about .40 per Sackett et al. (2022), which makes it one of our better predictors. The quiz therefore carries more weight than the reasoning test.

### Format

- Multiple choice with 4–5 options.
- Some items are "select all that apply". These are scored all-or-nothing.
- One item per screen, with a server-enforced deadline.
- Paste is blocked.
- Items are drawn at random from a bank of at least 60 items per role, stratified by topic.

### SWE blueprint

| Topic | Items |
|---|---|
| Postgres & SQL (joins, indexes, constraints, upserts, transactions) | 3 |
| Supabase security (RLS, grants, keys, `security definer`) | 3 |
| Next.js / Vercel (server vs client, env vars, caching, route handlers) | 2 |
| Data engineering (idempotency, normalisation, dedupe, schema drift) | 2 |
| Web security (OWASP basics, auth, secrets, rate limiting) | 2 |
| AI integration (structured output, cost control, prompt injection) | 2 |
| Ops (CI, monitoring, rollback, migrations) | 1 |

**Sample items:**

1. **A table is in `public`, has RLS enabled, and has one policy: `for select to authenticated using (true)`. Which statement is true?**
   - a) Anonymous users can read all rows
   - b) Any logged-in user can read all rows ✅
   - c) Only the row owner can read their rows
   - d) No one can read rows until an insert policy exists

2. **Which of these is safe to expose to the browser in a Supabase + Next.js app?** (select all)
   - the publishable/anon key ✅
   - the project URL ✅
   - the service-role key
   - the database connection string
   - `OPENROUTER_API_KEY`

3. **A monthly import re-runs on a file that is 95% identical to last month's. Customers are duplicating. What is the root fix?**
   - a) Delete all rows before each import
   - b) Upsert on a stable natural key with a unique constraint, and quarantine rows missing the key ✅
   - c) Add `DISTINCT` to the dashboard query
   - d) Run the import less often

4. **An LLM route is public and unauthenticated. What is the first risk to mitigate?**
   - a) Latency
   - b) Unbounded spend and abuse; add auth + rate limit + per-user budget ✅
   - c) Model accuracy
   - d) Response formatting

5. **A date column contains `8/4/2026`, `2026/13/08` and real Excel dates. What is the correct ingestion behaviour?**
   - a) Parse everything with the system locale
   - b) Parse with an explicit, ordered list of formats; reject impossible values; quarantine ambiguous ones (e.g. day ≤ 12 with no other signal) for review ✅
   - c) Drop the column
   - d) Store it as text and fix it in the UI

### BA blueprint

| Topic | Items |
|---|---|
| Elicitation techniques & stakeholder handling | 3 |
| Data literacy (grain, keys, joins, duplicates, nulls vs zero) | 4 |
| Requirements (user stories, acceptance criteria, non-functional, out-of-scope) | 3 |
| Process & metrics (funnel math, baselines, leading vs lagging indicators) | 2 |
| Compliance basics (POPIA direct marketing, consent, opt-out) | 2 |
| AI tool judgement (what to delegate, how to verify) | 1 |

**Sample items:**

1. **A sheet has one row per phone line. The client wants "one view per customer." What is the first thing you need to establish?**
   - a) The dashboard colours
   - b) The key that identifies a customer across lines, and whether it is reliable ✅
   - c) The number of rows
   - d) Which agent owns each row

2. **In a contact column, 17 of 127 cells contain `0`. What is the best interpretation?**
   - a) The customer's number is zero
   - b) Missing values stored as zero; treat as null and count them as uncontactable ✅
   - c) A formula error that can be ignored
   - d) Landline numbers

3. **Which acceptance criterion is testable?**
   - a) "Callbacks should be easy to schedule"
   - b) "Given an agent logs outcome 'Call back', when they save without a callback date, then the save is blocked and the date field is highlighted" ✅
   - c) "The system must be user-friendly"
   - d) "Agents will love the callback feature"

4. **Funnel: 1,687 calls → 865 connected → 76 opportunities → 22 sales. Where is the largest *relative* drop?**
   - a) Calls → connected
   - b) Connected → opportunity ✅ (8.8% conversion)
   - c) Opportunity → sale
   - d) Equal at all stages

5. **Under POPIA s69(3), a business may send electronic direct marketing *without prior opt-in consent* to an existing customer when…** (select all)
   - the details were obtained in the context of a sale ✅
   - the marketing is for its own similar products or services ✅
   - the customer was given an opportunity to object at collection *and* in every message ✅
   - the customer is a company, not an individual

### Scoring

- The result is the percentage correct. It is shown to the candidate along with their topic-level breakdown.
- Results below the role's quiz flag line (doc 03) are flagged for admin attention, not rejected.
- Item statistics are maintained the same way as for the reasoning test.
