# 02: Data Model (Supabase Postgres)

All tables live in `public` with RLS enabled.

- **Default posture:** revoke all privileges from `anon`, then grant only what each policy needs. Adding policies does not remove Supabase's default grants, so the revoke is required.
- **Helper:** `is_admin()` is a `security definer` function. It returns `exists(select 1 from admins where user_id = auth.uid())`. Set `search_path` explicitly.

## Identity and consent

```sql
admins(user_id uuid pk references auth.users)

profiles(
  user_id uuid pk references auth.users,
  full_name text, phone_e164 text, city text, province text,
  linkedin_url text, github_url text, portfolio_url text,
  created_at timestamptz default now())
-- RLS: owner select/update; admin select

consents(
  id uuid pk, user_id uuid, notice_version text,
  accepted_processing bool, accepted_ai_assessment bool,
  accepted_offshore_processing bool, talent_pool_opt_in bool,
  accepted_at timestamptz, ip inet, user_agent text)
-- insert-only for owner; admin select
```

## CVs and dedupe

```sql
cvs(
  id uuid pk, user_id uuid, storage_path text, file_sha256 text,
  text_extracted text, parsed jsonb, parse_model text, prompt_version text,
  embedding vector(1536), created_at timestamptz)
-- index: file_sha256; ivfflat/hnsw on embedding

dedupe_flags(
  id uuid pk, cv_id uuid, matched_cv_id uuid,
  kind text check (kind in ('exact_file','identity','semantic_high','semantic_review')),
  similarity numeric, matched_fields text[],
  status text default 'open' check (status in ('open','merged','not_duplicate','blocked')),
  resolved_by uuid, resolved_at timestamptz, note text)
-- admin only
```

## Roles and applications

```sql
roles(
  id uuid pk, slug text unique, title text, summary text, spec_md text,
  jd_md text,                       -- candidate-facing job description (lib/markdown.ts subset);
                                    -- spec_md stays short: the AI interviewer reads it
  salary_min int, salary_max int, location_note text,
  reasoning_min_stars int,          -- hurdle, see doc 04
  quiz_bank_id uuid, active bool)
-- public select where active; admin all

applications(
  id uuid pk, user_id uuid, role_id uuid,
  stage text,   -- interview|quiz|work_1|work_2|grading|shortlist|live|offer|closed
  status text,  -- in_progress|submitted|awaiting_review|advanced|rejected|withdrawn
  composite_score numeric, created_at timestamptz, updated_at timestamptz,
  unique(user_id, role_id))
-- owner select; only admin may update stage/status (enforced by policy + trigger)

decisions(
  id uuid pk, application_id uuid, stage text,
  decision text check (decision in ('advance','reject','hold')),
  reason text check (length(reason) >= 20),
  scores_snapshot jsonb, decided_by uuid, decided_at timestamptz)
-- admin insert/select; candidate select own (reason shown in results)

review_requests(
  id uuid pk, application_id uuid, stage text, message text,
  status text default 'open', response text, responded_by uuid, created_at timestamptz)
```

## Reasoning assessment

```sql
reasoning_items(
  id uuid pk, family text, -- number_series|letter_series|data_interp|syllogism|verbal_analogy|matrix_text|word_problem
  stem jsonb, options jsonb, answer_key text,
  generator text, params jsonb, -- for parametric items
  difficulty_p numeric,         -- running p-value (proportion correct)
  discrimination numeric,       -- point-biserial, recomputed nightly
  form text check (form in ('online','live')),
  active bool, version int)
-- admin only; candidates never select this table directly

reasoning_attempts(
  id uuid pk, user_id uuid, form text, item_ids uuid[],
  started_at timestamptz, deadline_at timestamptz, submitted_at timestamptz,
  raw_score int, percentile numeric, stars int, norm_version text)
-- owner select (score fields only, via view); one online attempt per 90 days enforced by constraint/trigger

reasoning_responses(
  attempt_id uuid, item_id uuid, position int, served_at timestamptz,
  answered_at timestamptz, answer text, correct bool,
  primary key(attempt_id, item_id))
```

Items are served **one at a time** by `POST /api/reasoning/next`. The handler writes `served_at`, and the answer is checked server-side. The client never receives the answer keys.

## Interview and quiz

```sql
interview_sessions(
  id uuid pk, application_id uuid, started_at timestamptz, deadline_at timestamptz,
  ended_at timestamptz, summary jsonb, score numeric, prompt_version text, model text)

interview_messages(
  id uuid pk, session_id uuid, role text, content text, created_at timestamptz,
  meta jsonb)   -- e.g. which CV claim was being probed

quiz_banks(id uuid pk, role_slug text, version int)
quiz_items(id uuid pk, bank_id uuid, topic text, stem text, options jsonb,
  answer_key text, difficulty_p numeric, active bool)
quiz_attempts(id uuid pk, application_id uuid, item_ids uuid[], started_at, deadline_at,
  submitted_at, raw_score int, pct numeric)
quiz_responses(attempt_id, item_id, answer, correct, served_at, answered_at)
```

## Work assessments

```sql
work_stages(
  id uuid pk, role_slug text, key text,  -- ba_part1|ba_part2|swe_test1|swe_test2
  title text, brief_md text, open_window interval, work_window interval,
  dataset_bundle text,   -- storage path of synthetic data pack for this stage
  rubric_id uuid, active bool)

work_attempts(
  id uuid pk, application_id uuid, stage_id uuid,
  unlocked_at timestamptz, started_at timestamptz, deadline_at timestamptz,
  submitted_at timestamptz, draft jsonb)

submissions(
  id uuid pk, attempt_id uuid,
  files text[],                 -- storage paths (memo, handoff, ERD...)
  repo_url text, repo_commit_sha text, deployed_url text, mvp_url text, loom_url text,
  snapshot jsonb,               -- html hash, screenshot paths, captured_at
  extracted_text text, sanitised_text text, injection_flags jsonb,
  created_at timestamptz)

persona_sessions(               -- BA Part 1 stakeholder chat
  id uuid pk, attempt_id uuid, persona_key text, started_at timestamptz)
persona_messages(id uuid pk, session_id uuid, role text, content text,
  revealed_fact_ids text[], created_at timestamptz)

verification_runs(              -- SWE Test 1 automated harness
  id uuid pk, submission_id uuid, check_key text, passed bool,
  detail jsonb, ran_at timestamptz)
```

## Grading

```sql
rubrics(id uuid pk, key text, version int, criteria jsonb, created_at)
-- criteria: [{key, title, weight, anchors:{1:..,3:..,5:..}, evidence_required:bool}]

grades(
  id uuid pk, submission_id uuid, rubric_id uuid, criterion_key text,
  sample_idx int, score numeric, evidence jsonb, rationale text,
  model text, prompt_version text, created_at timestamptz)

grade_summaries(
  submission_id uuid, criterion_key text, median_score numeric, spread numeric,
  needs_human_review bool, human_score numeric, human_reason text,
  final_score numeric, primary key(submission_id, criterion_key))

gold_samples(id uuid pk, rubric_id uuid, label text, file_path text,
  human_scores jsonb)           -- two independent human raters
calibration_runs(id uuid pk, rubric_id uuid, model text, prompt_version text,
  icc jsonb, qwk jsonb, ran_at timestamptz, passed bool)
```

## Live stage

```sql
live_scorecards(
  id uuid pk, application_id uuid, kind text, -- panel_interview|live_defence|live_elicitation|reasoning_retest|portfolio
  rater uuid, scores jsonb, notes text, created_at timestamptz)
```

Each rater submits their scorecard independently. The admin UI hides other raters' scores until the current rater has submitted.

## Signals and compliance

```sql
signals(id uuid pk, user_id uuid, context text, kind text, payload jsonb, created_at)
retention_queue(user_id uuid, purge_after date, reason text)
purge_log(user_id_hash text, purged_at timestamptz, scope text)
```

## Storage buckets (all private)

- `cvs/`
- `submissions/`
- `datasets/` (read-only signed URLs, issued only after the stage has started)
- `snapshots/`
- `gold/`

## Views exposed to candidates

| View | What it shows |
|---|---|
| `my_results` | stage, status, scores, stars, rubric-level final scores, feedback text |
| `my_reasoning` | raw score, percentile, stars, date |

These views never expose answer keys, evidence quotes about other candidates, or raw grader samples.
