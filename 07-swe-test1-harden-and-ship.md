# 07: SWE Test 1, Harden and Ship (Kopano Renewal Desk)

**Work window:** 72 hours from Start. **Intended effort:** about 6 hours. The window is long so people with jobs and families can take part. The effort is capped: the brief states it and tells candidates to prioritise.

**Environment:** the candidate's own GitHub and free-tier hosting. This is separate from Test 2.

## Why this test

The real job is taking a BA's AI-built prototype and making it production-grade. Canva, Meta and Shopify have all moved to this style of assessment: AI allowed, with **realistic, existing multi-file code**, scored on judgement, verification and production standards rather than puzzles.

The test has four elements:

1. **A planted-fault starter repo.** This is the "vibe-coded" MVP. The candidate is not told where the faults are. Finding them *is* the test.
2. **A messy monthly import to build.** This tests data engineering.
3. **Two handoff stories to implement.** This tests delivery against acceptance criteria.
4. **Deploy and document.** This tests ops and communication.

We grade with an **automated harness** first, then a human, then a live defence with AI off.

## What we give the candidate

The **starter repo** `chase-hiring/kopano-renewal-desk-starter` is a GitHub template. We build it once; see "Building the starter" below. It is a working Next.js + Supabase app with:
- a login
- a renewal queue
- a customer page
- outcome logging
- an "AI summary" button that calls OpenRouter

It looks finished. It is not.

The **handoff pack** comes from our reference BA answer: stories, ACs, access matrix and business rules.

The **data**:
- `base_month1.xlsx`: the messy synthetic base, with defects from doc 11
- `contacts_agent_sheets.xlsx`
- `optouts_legal.xlsx`, which is matched by company name only (D23/H04)

At grading time we also hold back `base_month2.xlsx`. The candidate never sees it.

We also give them a **capped OpenRouter key**, with a R50 credit limit per candidate, so candidates spend nothing.

### Planted faults

These are internal; never show this list to candidates.

| ID | Fault | Category | Detected by |
|---|---|---|---|
| F01 | `customers` table has RLS **disabled** | Security | Harness RLS probe + advisor |
| F02 | `interactions` has RLS enabled with policy `using (true)` for `authenticated`, so any agent sees every agent's interactions | Security | Cross-tenant probe |
| F03 | Default `anon` grants left on `lines` (RLS on, but a permissive select policy for `anon` was added "for the demo") | Security | Unauthenticated REST probe |
| F04 | Service-role key in `NEXT_PUBLIC_SUPABASE_SERVICE_KEY`, used in one client component | Security | Bundle scan |
| F05 | `/api/summary` (OpenRouter) has no auth, no rate limit and no max tokens | Cost/abuse | Burst probe (expect 429/401) |
| F06 | User text is interpolated straight into the AI prompt along with other customers' data (prompt-injection / data-leak path) | Security | Human review + injection probe |
| F07 | No migrations: the schema was created by hand in the dashboard and `schema.sql` is out of date | Ops | Repo check: `supabase/migrations/` + `db reset` |
| F08 | The "import" script deletes all rows then inserts, so customer IDs change every month and interaction history is orphaned | Data | Month-2 harness |
| F09 | Phone numbers stored as numbers (leading zero lost) | Data | Data check after import |
| F10 | "Call back" outcome saves without a callback date (validation only in the UI, which is bypassable) | Correctness | API probe |
| F11 | Contract status read from the stale export column instead of derived from the end date | Correctness | Data check |
| F12 | Opt-out list not applied to messaging | Compliance | Data check: an opted-out customer can be messaged |
| F13 | `.env.local` committed in an early commit and later deleted; the secret is still in history | Security | gitleaks |
| F14 | No error handling on the import: a bad row crashes the whole run, silently, leaving a partial import | Ops | Month-2 harness |

## Candidate brief (render verbatim)

> **Context:** Our BA built the Kopano Renewal Desk MVP with AI tools in two days. The client wants it live. The repo, the handoff pack and the client's latest data export are attached. **It works on the BA's laptop. That's all we know.**
>
> **Your job, in this order of priority:**
> 1. **Make it safe to put real customer data in.** Find and fix what's wrong. We haven't told you what's wrong; that's the point.
> 2. **Build the monthly import.** The client uploads their base export every month through the app. The import must be **safe to re-run**, normalise what needs normalising, put rows it can't trust into a quarantine report the manager can see, and **fail loudly** if the file's structure changes. Customer history must survive month to month.
> 3. **Implement stories RD-07 (mandatory callback date) and RD-11 (opt-out enforcement)** from the handoff pack, to their acceptance criteria.
> 4. **Deploy it.** Any free hosting is fine. Google Cloud Run's free tier, Vercel Hobby and Supabase Free all work, and we score resourcefulness. Seed it with the provided data and create two agent logins and one manager login for us.
>
> **Submit:**
> - the repo URL (we grade the commit SHA at submission)
> - the deployed URL
> - test logins
> - `README.md`: architecture, how to run locally, decisions, **what you found and fixed, and what you deliberately didn't do**
> - `RELEASE_NOTES.md`: half a page written *for Lerato, the client GM*
> - `docs/ADR-001.md`: one architecture decision record, covering one real choice you made, the options and why
> - a 5-minute Loom walking us through your three most important changes
>
> **Rules:** use any AI tools you like. You must be able to explain every line in a live session without AI. Expect about 6 hours of focused work. If you run out of time, write down what you'd do next; prioritisation is assessed. We will not use your work commercially, and you keep copyright.

## Verification harness

This lives at `scripts/verify-swe1/` and runs from an admin button. Each check writes a row to `verification_runs`.

### Repo checks (on the snapshot SHA)

| Key | Check | Pass condition |
|---|---|---|
| R1 | `gitleaks git` over the full history | The F13 secret is gone from history **or** the README documents the key rotation. The ideal is both: rotated *and* history rewritten. |
| R2 | Grep for `service_role`/`SERVICE`/`sb_secret_` in `NEXT_PUBLIC_*` or `'use client'` files | No matches |
| R3 | `supabase/migrations/` exists; `supabase db reset` on a scratch project applies cleanly | Applies cleanly, and every table has RLS |
| R4 | `npm ci && npm run lint && tsc --noEmit && npm run build` | Exit 0 |
| R5 | Tests exist and pass (`npm test`) | At least 1 test covers the import and at least 1 covers RD-07 |
| R6 | `.github/workflows/*` exists and the last run on the SHA is green | Green |
| R7 | `.env*` is gitignored and `.env.example` exists | Both true |

### Deployed-URL checks

| Key | Check | Pass condition |
|---|---|---|
| U1 | `GET /api/health` | 200, and the response touches the DB |
| U2 | Bundle scan: fetch the HTML and JS chunks, decode JWTs, search for `sb_secret_` | No service-role JWT, no secret key |
| U3 | Unauthenticated REST probe using the publishable key from the bundle: `GET /rest/v1/{customers,lines,interactions}?select=*` and `POST` | Empty result or rejected |
| U4 | Cross-tenant: log in as agent A and request agent B's interactions/allocations (REST and app routes) | Nothing returned |
| U5 | Burst 100 requests to the AI route, unauthenticated and authenticated | 401 for unauthenticated; 429 within the burst for authenticated, or a documented per-user cap |
| U6 | RD-07: POST outcome "call_back" without a date, via the API, bypassing the UI | Rejected (4xx); the DB constraint or a server check holds |
| U7 | RD-11: attempt to queue a message to a customer on the opt-out list (the list matches by name, so the candidate must resolve the match) | Blocked |
| U8 | Security headers: MDN Observatory API scan | Grade recorded (informational) |

### Month-2 import test

This is the deciding data test.

1. **Record a baseline:** customer count, line count, and interactions count for 5 sentinel customers.
2. **Upload `base_month2.xlsx`.** It contains:
   - 4% of lines changed (price plan or end date)
   - 2% new lines, including 15 for existing customers
   - 1.5% of lines removed (ported out, H14)
   - 30 duplicate rows
   - 20 rows with new phone-format defects
   - 10 ambiguous dates
3. **Assert:**
   - **M1:** customer count increases only by the true number of new customers (± 0); no duplication.
   - **M2:** the sentinel customers' interaction history is intact (same IDs).
   - **M3:** changed lines are updated, not duplicated.
   - **M4:** removed lines are marked inactive/ported, not deleted (history kept). Hard delete with documented reasoning gets partial credit.
   - **M5:** a quarantine report lists the ambiguous and invalid rows, with reasons.
   - **M6:** re-uploading the **same** month-2 file changes nothing (idempotency).
4. **Upload `base_month2_drift.xlsx`,** which has one column renamed (`Contract End Date` → `Contract_End`) and one column added.
   - **M7:** the import **fails loudly**, with a clear error naming the column, and writes no partial data.

### Data checks (on the deployed DB, via the admin/manager login or a provided read-only role)

- **D-a:** phones stored as E.164 text; landlines are distinguished from mobiles.
- **D-b:** contract status is derived from the end date, so there are no expired "InContract" lines.
- **D-c:** epoch dates are null or quarantined.

## Human review (after the harness)

Score against the rubric in doc 09 §6, criteria S1–S9. The reviewer reads:
- the README's "found and fixed" list: how many of F01–F14 were found and how they were described
- the ADR
- the release note
- the Loom

They also skim the import code and the RLS policies.

**Fault-discovery score:** the number of F01–F14 found and properly fixed, weighted. Security faults (F01–F06, F13) are weight 2; the rest are weight 1. The maximum is 21.

## Live defence (shortlist, 45 min, AI off for the debugging part)

1. **(10 min)** Walk us through your RLS policies. We ask: "What does agent A see if we add a shared-account feature tomorrow?"
2. **(15 min, AI off)** We introduce a bug into their deployed branch: a policy change or an off-by-one in the date window. They find it and explain it.
3. **(10 min)** Lerato asks for something unreasonable, for example: "Can we just WhatsApp everyone on the base tomorrow?" They respond as they would to a client executive.
4. **(10 min)** Questions about their trade-offs and what they deferred.

## Building the starter

This is our work, done once in Wave 3.

1. Build the clean reference app first: correct RLS, migrations, an idempotent import, RD-07 and RD-11. This becomes the **answer key** and is useful for calibrating the harness.
2. Fork it into the starter and inject F01–F14.
3. Recreate the F13 history: commit `.env.local` early, delete it later.
4. Run the harness against both repos. The reference must pass everything, and the starter must fail every check that maps to an F-code.
5. Keep both repos private. Candidates get the starter through "Use this template".
