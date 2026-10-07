# 01: Product Spec

## 1. Candidate journey

```
Sign up (email+password, verify email)
  → Consent & notice (POPIA, AI use, offshore processing, retention)
  → Profile + CV upload → CV parsed → dedupe check
  → Reasoning Assessment (30 Q / 15 min, once; retake after 90 days)      [platform-wide]
  → Apply to role(s): BA and/or SWE
      → AI CV-verification interview (~20 min, text, paste blocked)
      → Role quiz (15 Q / 12 min, timed, paste blocked)
      → Work assessments
           BA:  Part 1 Discovery & Spiky POV → Part 2 Build & Handoff
           SWE: Test 1 Harden & Ship → Test 2 Architecture & Costing
      → AI grading (advisory) → human review → shortlist
  → Live stage (human): structured panel interview + live defence of work
        + BA live elicitation role-play + reasoning retest (parallel form)
        + optional portfolio review
  → Decision & offer
```

### Stage gates

- A stage unlocks only when the previous stage is `submitted`.
- **Advancing** from AI-graded stages to the work assessments needs an **admin action**. The admin sees a recommended queue; nothing advances or rejects automatically.
- **Exception, for throughput:** an admin may switch on **batch-advance** for candidates above a configured threshold. The system then advances them *only after* the admin clicks "Advance N candidates" and confirms. Rejections are always individual and always carry a reason.

### Transparency

Candidates see their own results on `/me/results`:

- reasoning score, percentile and stars
- interview summary score
- quiz score
- rubric-level work-assessment scores, with short feedback
- current stage and status

They also see a **"Request a review"** button on every scored stage. It creates a `review_requests` row with free text. This is the s71 right to make representations.

## 2. Pages

**Candidate**
- `/` landing
- `/signup`, `/login`
- `/consent`
- `/profile` (profile fields, CV upload)
- `/assess/reasoning`
- `/roles`, `/roles/[slug]`
- `/apply/[role]/interview`, `/apply/[role]/quiz`
- `/apply/[role]/work/[stage]`
- `/me/results`

**Admin** (all under `/admin`, gated by the `admins` table)
- `roles`: CRUD for role spec, minimum star hurdle, quiz bank link, work-stage config, salary band
- `candidates`: table with filters, flags, scores; detail drawer showing CV, parsed profile, every attempt, transcripts, grades with evidence, signals
- `pipeline`: kanban by stage; batch-advance; decision modal with mandatory reason
- `dedupe`: flagged pairs side by side → merge / not duplicate / block
- `grading`: queue of `needs_human_review` grades; override with reason
- `live`: scorecards for panel interview, live defence, live elicitation, reasoning retest (enter score), with the online-vs-live delta shown
- `banks`: reasoning item bank, quiz banks, persona hidden facts, rubric versions
- `calibration`: gold set management, run graders against the gold set, ICC/kappa report per criterion
- `compliance`: retention queue, purge log, review requests, adverse-impact report

## 3. CV handling

1. **Upload:** PDF or DOCX, maximum 5 MB, to private bucket `cvs/{user_id}/`.
2. **Extract text:**
   - `pdf-parse` for PDFs, `mammoth` for DOCX.
   - If the text comes back empty (a scanned PDF), call a vision-capable model through OpenRouter on the page images.
3. **Parse** with an LLM into the JSON schema in `docs/10-prompts.md#cv-parser`:
   - identity (name, email, phone, LinkedIn, GitHub)
   - education
   - roles held (employer, title, dates, claims)
   - skills
   - links
4. **Dedupe:** three layers, stored in `dedupe_flags`. The thresholds are config values.
   - **File hash:** the SHA-256 of the uploaded file matches an existing CV → `exact_file`.
   - **Identity:** normalised email, E.164 phone, LinkedIn handle or GitHub handle matches another account → `identity`.
   - **Semantic:** embed the normalised CV text (OpenRouter embeddings model, 1536-dim, pgvector). Cosine similarity ≥ 0.92 → `semantic_high`; 0.85–0.92 → `semantic_review`.
   - A flag never blocks a candidate automatically. The admin resolves it.
   - **Purpose:** stop the same person opening a second account to retake the reasoning test. Phone OTP is a planned v2 control.

## 4. Anti-cheat signals (logged, never decisive on their own)

| Signal | Where | How |
|---|---|---|
| `paste_attempt` | interview, quiz, persona chat | `onPaste` preventDefault + log |
| `blur` / `focus` | all timed stages | `visibilitychange` events with timestamps |
| `burst_input` | text inputs | more than 150 characters arriving within 500 ms without key events |
| `answer_time` | reasoning, quiz | per-item server timestamps; flag a correct answer under 4 s on a hard item, or a long stall followed by a correct answer |
| `live_delta` | live retest | online percentile minus live percentile > 25 points → flag for discussion |
| `prompt_injection` | graders | the sanitiser finds instruction-like hidden text |

The **real** controls are design choices, not these signals:

- randomised item banks
- server-side timers
- parallel-form live retest
- live defence of submitted work with unseen follow-up questions

## 5. Timed work windows

**Every work stage has two clocks:**
- an `open_window`: how long the stage stays available after it unlocks, e.g. 7 days
- a `work_window`: starts when the candidate clicks **Start**, and sets `deadline_at = started_at + work_window`

**The submit page:**
- shows the server-derived countdown
- autosaves drafts
- disables submission after `deadline_at`; the API rejects late submissions too

**Window per stage:**

| Stage | Work window | Intended effort |
|---|---|---|
| BA Part 1 | 4 h | ~3 h |
| BA Part 2 | 48 h | ~4 h |
| SWE Test 1 | 72 h | ~6 h, scoped tight on purpose |
| SWE Test 2 | 24 h | ~3–4 h |

**Snapshotting:** for any link we must assess (repo, deployed URL, Loom, MVP), the platform snapshots it **at submission**:
- the repo commit SHA, recorded via the GitHub API
- the HTML of the URL plus a screenshot (Vercel function with Playwright, or a screenshot API)
- the Loom URL

Grading runs against the snapshot SHA, so later commits are ignored.

**Time and copyright notice.** Every brief states the intended effort and the window. It also states that we will not use submissions commercially and that the candidate keeps copyright. This is in writing in the brief (see `docs/12`).

## 6. Admin decision record

Each decision row holds:
- who
- when
- the stage
- the decision
- the reason (min 20 chars)
- the scores visible at decision time (JSON snapshot)

This is the audit trail for POPIA s71 and EEA s6/s8 disputes.
