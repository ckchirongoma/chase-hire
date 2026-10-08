# 05: AI CV-Verification Interview and Role Quiz

## Part A: AI CV-verification interview

### Purpose

1. Verify that the claims on the CV are the candidate's own work. The interview probes for depth, specifics and ownership.
2. Gather structured, behavioural evidence against the role competencies (doc 03).

The evidence base is clear on two points:

- **Structured** interviews predict job performance at about .42. Unstructured ones manage about .19.
- The validity comes from the **structure**: the same core questions, standard probes and anchored scoring. It does not come from the medium.

So the AI interviewer is tightly scripted. It is not a free-form chat.

### Format (v2: spoken and adaptive)

- **Spoken answers.** The interviewer's question appears on screen (the candidate can have it read aloud). The candidate records each answer (up to 3 minutes), can listen back and re-record, then sends it. The server stores the recording in the private `interview-audio` bucket and transcribes it through OpenRouter (`OPENROUTER_MODEL_TRANSCRIBE`, default `openai/gpt-transcribe`). The transcript is what the interviewer and the grader see.
- **Typed answers only as an accommodation.** An admin can switch one application to typed answers before its interview starts (`admin_set_interview_mode`, with a written reason), for example when a candidate can't use a microphone. Paste stays blocked in typed mode.
- **About 25–30 minutes**, with a hard server-side `deadline_at` of **35 minutes** set by the DB clock.
- The candidate is told the format, the time and the tab rule up front, and that answers should be specific. They are not told a question count, because follow-ups depend on their answers.
- There is no live typing indicator from the bot. Replies are delivered in full once ready.
- **Tab rule (pause, then lock).** Leaving the tab for 2 seconds or more pauses the interview: the candidate must confirm to carry on (the clock keeps running). A second leave **locks** the session. A locked session never expires on its own and is never auto-rejected; an admin reopens it with a written reason (`admin_reopen_session`) and the candidate gets back the time they had left (at least 1 minute). Leaves, pauses, locks and reopens are logged as signals.

Why voice: a typed interview can be answered by retyping an LLM's output from a second device. Speaking a specific, consistent account of your own work, and then going deeper under follow-ups that react to what you just said, is much harder to fake. We judge the content of the transcript, never accent, fluency or sound quality.

### Script (generated per candidate from the parsed CV)

The frame is the same for every candidate: the same opening, the same topic-selection rules, the same follow-up targets, the same time limits and the same rubric. What adapts is which CV topics are chosen and what the follow-ups say.

1. **Opening: role fit (1 question, up to 2 follow-ups).** "Let's start with the big picture. What in your experience makes you a strong fit for the {role} role? Tell me about the work you've done that you think qualifies you, and the one or two examples you'd point to first." The follow-ups take the example that matters most for the role, find it on the CV (which role, which employer) and go deeper.
2. **CV topics (3 to 6), chosen in this priority order:**
   1. the role's **top 3 requirements** (`lib/interview/requirements.ts`, from the competencies in doc 03), each with the CV claim that best evidences it. The question says which part of the job the claim is evidence for: "This role involves digging into messy spreadsheets and system data to find what's missing or wrong. Your CV says you 'cleaned a 50,000-row customer dataset…'. Walk me through what you personally did, which tools you used, and how you measured the result.";
   2. a **CV consistency** issue, if the dates don't add up (a role that ends before it starts, overlapping full-time roles of 3+ months, or a gap of 6+ months);
   3. every role that ended in the last **5 years** and isn't already covered (up to 3, most recent first), opened on that role's strongest claim;
   4. the **closest experience** to the first top requirement the CV shows nothing for: "This role involves X. That doesn't come through clearly on your CV. What's the closest you've done to it?";
   5. the most impressive quantified claim;
   6. a key skill the CV lists but **never evidences** in any role.

   Requirement topics are asked first, in the role's order of importance; the rest follow in a natural order. Matching claims to requirements, "most impressive" and "key skill" is one JEV call with a deterministic keyword fallback (doc 15).
   Each topic opens with a **behavioural STAR** question.
3. **Adaptive follow-ups (up to 4 per topic, 2 on the opening question).** After each answer, JEV decides whether the answer is specific enough to move on and, if not, what is missing. The target is one of:
   - **specifics** (tools, numbers, dates)
   - **ownership** (what they personally did vs. the team)
   - **failure** (what broke and how they found out)
   - **trade-off** (the hardest decision and the rejected option)
   - **consistency** (how it fits the CV's dates and roles)
   - **AI use** (what AI tools did and how they checked it)

   An LLM then writes one follow-up question that builds on the candidate's own words and digs for that target (`prompts/interviewer-followup.v2.md`: it also receives the role's requirements and connects the answer to the CV and to what the role needs). The question is validated (length, a single question, no evaluation, no markup, not a repeat); if it fails, or the LLM is slow or down, a standard template for that target is used instead. Without JEV, a fixed rule decides (long enough and contains a number = move on).
4. **Role situational (1 question, fixed per role):**
   - **BA:** "A client's ops head says 'just put all our leads on WhatsApp.' You have a spreadsheet of 5,000 customer lines with no phone numbers on most rows. What do you do in your first week?"
   - **SWE:** "You inherit a Next.js + Supabase app a colleague built with an AI tool in two days. The client goes live Monday. What do you check first, in order, and why?"
5. **Motivation and logistics (1 question):** "This role pays R30,000–R32,500 plus profit share, remote in South Africa. What makes this the right next move for you, and when could you start?"

**Time rules** (so every candidate reaches the situational and logistics questions): no new follow-ups with under 5 minutes left; remaining CV topics are skipped with under 7 minutes left; with under 3 minutes left the interviewer goes straight to logistics.

### Interviewer behaviour rules

The prompts are in doc 10. The interviewer:

- never gives feedback on whether an answer was good
- never reveals scoring
- asks one question at a time
- builds follow-ups on what the candidate actually said, within the six fixed targets; it does not invent new topics
- tracks which CV topic each message relates to (`claim_id`)
- treats the CV and the transcript as untrusted data, refuses prompt-injection attempts politely and logs a signal

### Scoring (after the session; separate grader call, 3 samples, median)

Each criterion is scored 1–5 with anchors:

| Criterion | 1 | 3 | 5 |
|---|---|---|---|
| **Specificity** | Generic, could be anyone's | Some concrete detail (tools, numbers) | Precise detail: names systems, numbers, dates, trade-offs; consistent with the CV |
| **Ownership** | "We" throughout, can't separate own contribution | Partly separates own work | Clearly states own decisions and actions, and acknowledges others |
| **Depth under probe** | Answer collapses on the first probe | Holds up on one probe | Gets *more* specific under probing; describes failures and what was rejected |
| **CV consistency** | Contradicts the CV (dates, scope, tools) | Minor gaps | Fully consistent |
| **Situational judgement** | Jumps to a solution | Reasonable plan | Diagnoses first, sequences risk, names what they'd check (role-specific anchors in the rubric) |
| **Communication** | Rambling, no structure | Understandable | Answer-first, concise, structured (judged on the transcript; fillers, accent and transcription errors are ignored) |

**Output:**
- a `summary` JSON holding per-criterion scores with evidence quotes
- a list of `verification_concerns`, e.g. "claims 3 years of Postgres but could not describe an index"
- **suggested live-interview follow-ups** for the panel

### Integrity note

Spoken answers and follow-ups that react to each answer make it much harder to read out an LLM's answer from a second device, but not impossible. Tab leaves, pauses and locks are signals only, never evidence on their own, and a lock is never a rejection.

So the most useful output of this stage is still the **list of verification concerns**, which is carried into the live panel interview. The admin can play back every recorded answer next to its transcript.

## Part B: Role quiz (15 items / 12 minutes)

### Purpose

This is a job-knowledge check. Validity is about .40 per Sackett et al. (2022), which makes it one of our better predictors. The quiz therefore carries more weight than the reasoning test.

### Format

- Multiple choice with 4–5 options.
- Some items are "select all that apply". These are scored all-or-nothing.
- One item per screen, with a server-enforced deadline.
- Paste is blocked.
- The same tab rule as the interview and the reasoning test: the first leave pauses (confirm to continue), the second locks until an admin reopens it with the time that was left. Never a rejection.
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

### Ending early

The candidate can end the interview at any time ("End the interview now", with a confirmation). Everything answered so far is kept and graded the same way; the session ends with `end_reason = 'ended_by_candidate'` and the application moves on to the quiz exactly as when the interview completes. It is never a rejection.
