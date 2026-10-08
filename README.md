# Chase Hiring Platform

Recruitment and assessment platform Chase Agents uses to hire an **AI-native Business Analyst** and an
**AI-native Software Engineer**. Read `CLAUDE.md` and `docs/` (in order) before changing anything.

Stack: Next.js 15 (App Router, TypeScript) on Vercel · Supabase (Postgres + RLS, Auth, Storage,
pgvector) · OpenRouter (every LLM call, plus speech-to-text) · JEV / TypeSafe System One (fast flow
decisions only, never grades or hiring decisions).

**Humans decide.** No code path rejects anyone automatically. Scores, flags and composites sort and
recommend; every advance or reject is an admin decision with a written reason (POPIA s71).

## What a candidate does

1. Sign up, confirm email, accept the POPIA notice, upload a CV (parsed and checked for duplicates).
2. Reasoning Assessment: 30 generated items in 15 minutes, server-timed, once per 90 days, stars.
3. Apply to a role. Below the star hurdle → held for a person to review, never rejected.
4. AI CV interview: a spoken conversation, about 25–30 minutes (35-minute hard limit). Answers are
   recorded and transcribed; 3–6 CV topics with up to 4 follow-ups each, built from the candidate's
   own words. Typed answers only as an admin-approved accommodation.
5. Role quiz: 15 items in 12 minutes, paste blocked.
6. Work assessments (BA Part 1 + 2, SWE Test 1 + 2), AI-graded with evidence, 3 samples, median.
7. Live stage with people, then the decision.

Timed stages follow the **tab rule**: the first time the candidate leaves the page the stage pauses
until they confirm; the second time it locks until an admin reopens it with the time that was left.
A lock is never a rejection.

## Deploying (Vercel + Supabase)

1. **Supabase migrations.** Apply everything in `supabase/migrations/` in order to the "Chase hire"
   project: `npx supabase link --project-ref <ref> && npx supabase db push` (or paste each file into
   the SQL editor). Never edit a migration that has already been applied; add a new one.
2. **Supabase Auth** (dashboard → Authentication):
   - URL configuration: Site URL = your Vercel URL; add `https://<your-domain>/**` to Redirect URLs.
   - Email confirmation: on (the default).
   - Custom SMTP: required for real volumes (the built-in sender is heavily rate-limited).
3. **Vercel environment variables** (see `.env.example`):

   | Variable | Notes |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public |
   | `NEXT_PUBLIC_SITE_URL` | e.g. `https://hire.example.co.za` |
   | `SUPABASE_SECRET_KEY` | **Server only.** Never prefix with `NEXT_PUBLIC_` |
   | `OPENROUTER_API_KEY` | **Server only** |
   | `OPENROUTER_MODEL_CV_PARSE`, `OPENROUTER_MODEL_CV_VISION` | CV parsing (vision for scanned PDFs) |
   | `OPENROUTER_MODEL_EMBED` | Default `openai/text-embedding-3-small` (1536-dim dedupe) |
   | `OPENROUTER_MODEL_GRADER` | Strong reasoning model for every grader |
   | `OPENROUTER_MODEL_PERSONA` | Fast model for the BA stakeholder persona |
   | `OPENROUTER_MODEL_INTERVIEWER` | Writes the interview follow-ups (optional; falls back to the persona model) |
   | `OPENROUTER_MODEL_TRANSCRIBE` | Speech-to-text, default `openai/whisper-1` |
   | `TYPESAFE_API_KEY`, `JEV_MODEL` | JEV (optional; every JEV decision has a deterministic fallback). Default model `jev-1.13.0` |
   | `CRON_SECRET` | 16+ characters; Vercel Cron sends it as a bearer token |

   Changing a grader's model, prompt or rubric means re-running the calibration gold set
   (`docs/09` §8) before going live.
4. **Make yourself an admin.** Sign up through the site, then in the SQL editor:
   `insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';`
5. **Cron.** `vercel.json` runs `/api/cron/sweep` daily. It finalises abandoned timed stages, ends
   expired interviews (never locked ones), retries grading jobs and refreshes composite scores. It
   never advances or rejects anyone. Every timed stage is also finalised lazily when the candidate
   next loads it, and grading starts right after a stage ends, so the daily schedule is a safety net.
6. **Assessment data.** Generate and upload the synthetic datasets with `scripts/synth/` (see
   `docs/11`). Real client material in `context/` never reaches candidates.

## Local development

```bash
npm install
npx supabase start            # needs Docker
cp .env.example .env.local    # fill with values from `npx supabase status`
npm run dev
```

## Tests

| Command | What |
|---|---|
| `npm test` | Unit tests (Vitest): item generators, scoring, stars, timers, sanitiser, CV parsing, dedupe thresholds, OpenRouter + JEV clients, interview planning/engine/follow-up checks, grading aggregation, composites |
| `npm run test:int` | Integration tests against local Supabase (Docker) with an offline AI/JEV stub: RLS on every table, no auto-reject, DB-enforced timers, the tab rule, spoken answers, grading, work stages, pipeline and batch advance |
| `npm run test:e2e` | Playwright on a production build: sign up → confirm → consent → CV → reasoning → apply → spoken AI interview (fake microphone) → quiz → scores; dedupe flag; admin views; pipeline batch advance. Set `PW_CHROMIUM_PATH` to use a preinstalled Chromium |

The AI stub (`tests/stubs/ai-stub.mjs`) answers OpenRouter by prompt version
(`tests/stubs/prompts/<key>.mjs`), transcribes test audio and answers JEV, so tests are free and
deterministic. Integration tests read the local Supabase keys from `npx supabase status`.

## Where things live

| Path | What |
|---|---|
| `supabase/migrations/` | Schema, RLS, triggers (timers, tab-rule guards, no-auto-reject guard), RPCs (`admin_decide`, `admin_batch_advance`, `admin_reopen_session`, `admin_set_interview_mode`, …) |
| `lib/reasoning/`, `lib/server/reasoning.ts` | Reasoning Assessment: seeded generators, blueprint, scoring/stars, attempt lifecycle |
| `lib/cv/`, `lib/server/cv.ts` | Text extraction, AI parsing, 3-layer dedupe |
| `lib/interview/`, `lib/server/interview.ts` | AI CV interview: topic plan, conversation engine, JEV turn classifier, LLM follow-ups with validation, transcription |
| `lib/quiz/`, `lib/server/quiz.ts` | Role quiz |
| `lib/work/`, `lib/persona/`, `lib/server/work.ts`, `lib/server/persona.ts` | Work stages, BA stakeholder persona |
| `lib/grading/`, `lib/server/grading.ts`, `lib/server/grade-submission.ts` | Graders (one criterion per call, 3 samples, median, evidence), job queue |
| `lib/scoring/`, `lib/server/scores.ts` | Composite and final scores (docs/09) |
| `lib/jev/` | JEV client (`docs/15`) |
| `lib/ai/` | OpenRouter client (JSON output + Zod + one retry, no data retention, transcription) |
| `lib/sanitise.ts` | Hostile-input sanitiser |
| `prompts/` | Versioned prompts (`<key>.v<n>.md`) |
| `lib/consent/notice.ts` | POPIA notice (DRAFT: needs legal review; bump the version on any change) |
| `app/admin/` | Pipeline, candidates, grading queue, review requests, dedupe, roles, banks, rubrics |
| `scripts/synth/` | Synthetic assessment datasets with planted defects and answer keys |
