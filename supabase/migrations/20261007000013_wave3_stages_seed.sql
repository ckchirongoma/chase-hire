-- Wave 3 content: the four work-assessment stages (briefs rendered verbatim from docs 06-08)
-- and work_submit(), which freezes a submission and closes its attempt in one transaction.
-- Also: the start window opens with the admin decision that unlocks a work stage
-- (admin_decide creates the attempt; work_attempt_guard anchors lazily created ones), releasing
-- a hold at a work stage before its work is submitted keeps the stage (as for the interview and
-- the quiz), and submissions keep the total word count and review flags.
--
-- Re-runnable: stages upsert on their key; functions are create-or-replace.
-- Briefs are candidate-facing text only. Planted faults, answer keys, hidden persona facts and
-- internal reference prices live in the docs, rubrics.reference and the datasets bucket's
-- internal/ folders, never here.

-- ───────────────────────── Stages ─────────────────────────
insert into public.work_stages
  (role_slug, key, app_stage, title, brief_md, intended_effort, open_window, work_window,
   dataset_bundle, rubric_key, word_limit, page_limit, active)
values
('business-analyst', 'ba_part1', 'work_1', 'BA Part 1: Discovery, gaps and Spiky POV',
$brief$**Client:** Kopano Connect, a mobile network dealer. Their Virtual Sales team phones existing business customers to renew and upgrade contracts.

**The ask, from their GM Virtual Sales:** *"Automate our renewal outreach. WhatsApp, SMS and email, starting three months before each contract ends, and give my agents one view per customer."*

**You have:**
1. `kopano_vsam_extract.xlsx`, containing four sheets:
   - the monthly customer base export
   - one agent's working sheet
   - telephony stats for last month
   - the team's daily activity log
2. **A 25-minute chat with Lerato Dube, GM Virtual Sales** (the "Interview the client" tab). She is busy and answers what you ask, not what you should have asked. You can send up to 25 messages. The chat is logged and assessed.
3. The open internet. AI tools are allowed and expected.

**Deliver one document (PDF or DOCX, max 1,500 words excluding appendices):**
1. **Executive summary** (≤150 words): your recommendation and the decision you need from Lerato.
2. **Purpose:** the business question, and what is in and out of scope.
3. **Facts:** the specific, verifiable things you found, each cited to sheet/column or to the interview.
4. **Insights:** the patterns that are *not* obvious. Each one should connect two or more facts or sources.
5. **Spiky POV:** one to three positions a reasonable person could disagree with. For each:
   - the evidence
   - the strongest counter-argument
   - why it loses here
6. **Solution:** what to build first, what to fix before building, and what *not* to build.
7. **Success criteria:** for each, give the metric, the baseline from the data, the target, the timeframe, and **the result that would prove you wrong**.
8. **AI-use note** (≤100 words): what AI did for you, and what you did yourself.

**Appendix A: Gap log.** A table with these columns: Gap | Evidence (sheet/column/row count) | What it blocks | Severity (Critical/High/Medium/Low) | Proposed fix.

**Appendix B: Questions.** The questions you would still ask, and who you would ask.

**How you'll be assessed:**
- what you found
- what you got out of the client
- how well your point of view is argued and evidenced
- whether your success criteria are measurable
- how clearly you write for an executive

**Note:** we will not use your work commercially, and you keep copyright.$brief$,
 'About 3 hours', interval '7 days', interval '4 hours', 'v1/bundle_a', 'ba_part1', 1500, null, true),

('business-analyst', 'ba_part2', 'work_2', 'BA Part 2: Build and handoff',
$brief$Lerato has accepted a solution direction. We've attached:
- the **Solution Brief**, a one-page summary of the agreed approach
- a **cleaned dataset**: customers, accounts, lines, contact points with consent flags, agents, normalised dates

Your job is to show us the first working version and hand it to our engineer.

**Deliver:**
1. **Data model:**
   - an ERD (image or Mermaid)
   - table definitions: name, purpose, columns, types, keys
   - the grain of each table, in one sentence
2. **Clickable MVP, hosted, running on the provided data.** Use any free tool. Lovable or v0 with Supabase both work on free tiers. It must include:
   - **Renewal queue:** lines and customers entering the 90-day window, prioritised, with eligibility rules applied
   - **Customer 360:** accounts, lines, contact points + consent, interaction history
   - **Log outcome:** a callback date is **required** for "Call back"; quote, sale and not-interested outcomes all available
   - **Message:** compose from an approved template, blocked if there's no consent or the customer has opted out; queued, not actually sent
   - **Manager exceptions view:** missing next actions, overdue callbacks, customers with no valid contact point
3. **Handoff pack for the engineer** (DOCX/PDF/MD) using our template:
   - the problem and the POV in 5 lines
   - user stories with Given/When/Then acceptance criteria
   - business rules (eligibility, consent, allocation, deduplication)
   - an **access matrix**: role × action (agent, manager, admin)
   - edge cases
   - non-functional needs
   - out of scope
   - open questions
4. **A 5-minute Loom demo, addressed to Lerato.** What it does, what it doesn't, and the decision you need from her.

**Note:** we will not use your work commercially, and you keep copyright.

## Solution Brief

**Agreed direction:** fix contactability and next-action discipline before automating channels. Phase 1 is a Renewal Desk:
- one customer record
- verified contact points with a consent status
- a 90-day renewal queue
- mandatory dated next actions
- template messaging only to consented, contactable customers
- a manager exceptions view

Bulk outreach is out of scope until the contactable share passes 60%.$brief$,
 'About 4 hours', interval '7 days', interval '48 hours', 'v1/bundle_b', 'ba_part2', null, null, true),

('software-engineer', 'swe_test1', 'work_1', 'SWE Test 1: Harden and ship',
$brief$**Context:** Our BA built the Kopano Renewal Desk MVP with AI tools in two days. The client wants it live. The repo, the handoff pack and the client's latest data export are attached. **It works on the BA's laptop. That's all we know.**

**Your job, in this order of priority:**
1. **Make it safe to put real customer data in.** Find and fix what's wrong. We haven't told you what's wrong; that's the point.
2. **Build the monthly import.** The client uploads their base export every month through the app. The import must be **safe to re-run**, normalise what needs normalising, put rows it can't trust into a quarantine report the manager can see, and **fail loudly** if the file's structure changes. Customer history must survive month to month.
3. **Implement stories RD-07 (mandatory callback date) and RD-11 (opt-out enforcement)** from the handoff pack, to their acceptance criteria.
4. **Deploy it.** Any free hosting is fine. Google Cloud Run's free tier, Vercel Hobby and Supabase Free all work, and we score resourcefulness. Seed it with the provided data and create two agent logins and one manager login for us.

**Submit:**
- the repo URL (we grade the commit SHA at submission)
- the deployed URL
- test logins
- `README.md`: architecture, how to run locally, decisions, **what you found and fixed, and what you deliberately didn't do**
- `RELEASE_NOTES.md`: half a page written *for Lerato, the client GM*
- `docs/ADR-001.md`: one architecture decision record, covering one real choice you made, the options and why
- a 5-minute Loom walking us through your three most important changes

**Rules:** use any AI tools you like. You must be able to explain every line in a live session without AI. Expect about 6 hours of focused work. If you run out of time, write down what you'd do next; prioritisation is assessed. We will not use your work commercially, and you keep copyright.

**Downloads:** the starter repository link and the handoff pack are in the Downloads list once you press Start, together with the client's data files.$brief$,
 'About 6 hours', interval '7 days', interval '72 hours', 'v1/bundle_c', 'swe_test1', null, null, true),

('software-engineer', 'swe_test2', 'work_2', 'SWE Test 2: Architecture and costing',
$brief$**Client:** Mzansi Heritage Records, a South African label with a **127,000-track catalogue** going back decades.

**How their music reaches the world:** a global aggregator distributes the catalogue to about 250 streaming and social platforms. The aggregator also handles YouTube for them.

**What they want, in the CEO's words:**
*"I want our own system that finds every unauthorised use of our music: YouTube, TikTok, Instagram, random websites, and our own platform, Stage, where producers can now download stems. Find it, prove it's ours, and send it to legal so they can take it down. Our legal head wants takedowns to go out automatically, so we're not paying people to click buttons. Budget-wise I'm thinking R15,000 a month to run."*

**Data room** (in the platform):
- **Current stack:**
  - catalogue metadata in FileMaker
  - Stage runs on Postgres + S3
  - masters are 24-bit WAV, some 96 kHz
  - an internal team has started a fingerprint database; it's about 40% done
- **People:** a 4-person engineering team (Stage), plus a publishing team and a legal team (2 people).
- **Volume hint:** Stage gets about 300 stem downloads a day.
- **Note from legal:** *"We'd like to start with YouTube. We see our songs everywhere there."*

**Deliver:**
1. **A memo** (PDF/DOCX/MD, max 6 pages including diagrams), structured as:
   - **Executive summary for the CEO** (½ page): your recommendation, cost, timeline, and the decisions you need from them.
   - **Architecture:**
     - a diagram
     - components
     - data flow (Extract → Match → Score → Remember → Route)
     - what you **build** vs **buy** vs **register for**, and why
   - **Platform reality:** what you can and can't reach on each platform, and how.
   - **Cost model in rands:**
     - build cost (effort estimate)
     - monthly running cost broken into drivers, with **your assumptions stated**
     - sensitivity: what moves the number
     - USD → ZAR conversions shown
   - **Security:** how you protect unreleased masters and the evidence trail.
   - **Maintenance & operations:** what breaks over time, who watches it, cost.
   - **Risks, and what you'd tell the CEO they can't have.**
   - **Phased plan:** phases with exit criteria, and at least one **kill criterion** (a result that should stop or redirect the project).
2. **A 5-minute Loom** pitching your recommendation to the CEO. They are not technical.

**Rules:**
- Research is expected; cite sources.
- Where a vendor doesn't publish prices, say so and state your assumption. Don't invent precision.
- AI tools are allowed.
- We will not use your work commercially, and you keep copyright.$brief$,
 'About 3–4 hours', interval '7 days', interval '24 hours', 'v1/bundle_d', 'swe_test2', null, 6, true)
on conflict (key) do update set
  role_slug = excluded.role_slug,
  app_stage = excluded.app_stage,
  title = excluded.title,
  brief_md = excluded.brief_md,
  intended_effort = excluded.intended_effort,
  open_window = excluded.open_window,
  work_window = excluded.work_window,
  dataset_bundle = excluded.dataset_bundle,
  rubric_key = excluded.rubric_key,
  word_limit = excluded.word_limit,
  page_limit = excluded.page_limit,
  active = excluded.active;

-- ───────────────────────── Submission review fields ─────────────────────────
-- word_count_total: every word in the main document (word_count is the BA Part 1 body only).
-- review_flags: things a person should check, never evidence or a decision on their own, e.g.
--   {"kind": "appendix_share", ...}  most of the memo sits after the first "Appendix" heading
--   {"kind": "late_snapshot", ...}   a link or the repo SHA was captured > 60 s after submission
alter table public.submissions add column if not exists word_count_total int;
alter table public.submissions add column if not exists review_flags jsonb not null default '[]';

-- ───────────────────────── Work attempt clock ─────────────────────────
-- Same rules as migration 0011, plus:
--   * INSERT: the start window (unlocked_at, open_until = unlocked_at + open_window) runs from
--     the latest 'advance' decision on the application, i.e. the decision that unlocked the
--     stage, not from the candidate's first visit (no decision, e.g. test setup: now()).
--   * UPDATE: admin_decide may re-open the start window of an attempt that has not been
--     started (releasing a hold, or re-advancing after the window lapsed). It signals this with
--     the transaction-local setting chase.work_reopen = 'on'; nothing else can move the window.
create or replace function public.work_attempt_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  st record;
  anchor timestamptz;
begin
  select open_window, work_window into st from public.work_stages where id = new.stage_id;
  if tg_op = 'INSERT' then
    select max(d.decided_at) into anchor
      from public.decisions d
     where d.application_id = new.application_id and d.decision = 'advance' and d.decided_at <= now();
    new.unlocked_at := coalesce(anchor, now());
    new.open_until := new.unlocked_at + st.open_window;
    new.started_at := null;
    new.deadline_at := null;
    new.submitted_at := null;
    return new;
  end if;

  if new.unlocked_at is distinct from old.unlocked_at or new.open_until is distinct from old.open_until then
    if coalesce(current_setting('chase.work_reopen', true), '') <> 'on'
       or old.started_at is not null or old.submitted_at is not null then
      raise exception 'work_attempt_immutable' using errcode = 'P0001';
    end if;
    new.unlocked_at := now();
    new.open_until := now() + st.open_window;
  end if;

  if new.application_id <> old.application_id or new.stage_id <> old.stage_id or new.user_id <> old.user_id then
    raise exception 'work_attempt_immutable' using errcode = 'P0001';
  end if;

  -- Start: once, before the open window closes; the DB clock sets the deadline.
  if old.started_at is null and new.started_at is not null then
    if now() > old.open_until then
      raise exception 'work_open_window_closed' using errcode = 'P0001';
    end if;
    new.started_at := now();
    new.deadline_at := now() + st.work_window;
  elsif new.started_at is distinct from old.started_at or new.deadline_at is distinct from old.deadline_at then
    raise exception 'work_attempt_immutable' using errcode = 'P0001';
  end if;

  if old.submitted_at is not null then
    if new.submitted_at is distinct from old.submitted_at or new.draft is distinct from old.draft then
      raise exception 'work_already_submitted' using errcode = 'P0001';
    end if;
  end if;

  -- Submit / autosave: only between start and deadline (+5 s grace).
  if (new.submitted_at is not null and old.submitted_at is null) or new.draft is distinct from old.draft then
    if old.started_at is null then
      raise exception 'work_not_started' using errcode = 'P0001';
    end if;
    if now() > old.deadline_at + interval '5 seconds' then
      raise exception 'work_deadline_passed' using errcode = 'P0001';
    end if;
    if new.submitted_at is not null and old.submitted_at is null then
      new.submitted_at := now();
    end if;
    if new.draft is distinct from old.draft then
      new.draft_saved_at := now();
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.work_attempt_guard() from public, anon, authenticated;

-- ───────────────────────── Admin decision: work stages ─────────────────────────
-- Same as migration 0010 (which kept 0008's rules and added the quiz hold release), plus:
--   * 'advance' at work_1 / work_2 before that stage's work has been submitted keeps the stage
--     (releasing a hold must not skip BA Part 1, SWE Test 1, BA Part 2 or SWE Test 2; docs/01
--     stage gates, docs/06 Part 2 unlock condition). Status: 'in_progress' if the candidate has
--     already pressed Start, otherwise 'advanced'.
--   * when an 'advance' leaves the application at a work stage, the stage's attempt is created
--     (or, if it was never started, its start window re-opened) by this decision, so the open
--     window runs from the decision, not from the candidate's first visit.
-- If a later migration redefines admin_decide, it must keep these rules and the interview/quiz
-- ones (tests/integration/work.test.ts, quiz.test.ts and interview.test.ts check them).
create or replace function public.admin_decide(
  p_application_id uuid,
  p_decision text,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  app public.applications%rowtype;
  snapshot jsonb;
  decision_id uuid;
  next_stage text;
  next_status text := 'advanced';
  v_stage_id uuid;
  wa record;
begin
  if not public.is_admin() then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  if p_decision not in ('advance', 'reject', 'hold') then
    raise exception 'invalid_decision' using errcode = 'P0001';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 20 then
    raise exception 'reason_too_short' using errcode = 'P0001';
  end if;

  select * into app from public.applications where id = p_application_id for update;
  if not found then
    raise exception 'application_not_found' using errcode = 'P0002';
  end if;

  snapshot := public.application_scores(app.id);

  insert into public.decisions (application_id, stage, decision, reason, scores_snapshot, decided_by)
  values (app.id, app.stage, p_decision, btrim(p_reason), snapshot, auth.uid())
  returning id into decision_id;

  if p_decision = 'advance' then
    -- Releasing a hold before the candidate has done the stage's own assessment keeps the
    -- stage: before the interview has ended, before the role quiz has been submitted, or
    -- before the work stage's submission.
    if app.stage = 'interview' and not exists (
      select 1 from public.interview_sessions s where s.application_id = app.id and s.ended_at is not null
    ) then
      next_stage := 'interview';
    elsif app.stage = 'quiz' and not exists (
      select 1 from public.quiz_attempts q where q.application_id = app.id and q.submitted_at is not null
    ) then
      next_stage := 'quiz';
    elsif app.stage in ('work_1', 'work_2') and not exists (
      select 1
        from public.work_attempts x
        join public.work_stages ws on ws.id = x.stage_id
       where x.application_id = app.id and ws.app_stage = app.stage and x.submitted_at is not null
    ) then
      next_stage := app.stage;
    else
      next_stage := case app.stage
        when 'interview' then 'quiz' when 'quiz' then 'work_1' when 'work_1' then 'work_2'
        when 'work_2' then 'shortlist' when 'grading' then 'shortlist' when 'shortlist' then 'live'
        when 'live' then 'offer' when 'offer' then 'closed' else app.stage end;
    end if;

    -- A work stage unlocks with this decision: create its attempt (work_attempt_guard anchors
    -- the start window to this decision), or re-open the start window if it was never started.
    if next_stage in ('work_1', 'work_2') then
      select ws.id into v_stage_id
        from public.work_stages ws
        join public.roles r on r.slug = ws.role_slug
       where r.id = app.role_id and ws.app_stage = next_stage and ws.active;
      if v_stage_id is not null then
        select x.id, x.started_at, x.submitted_at into wa
          from public.work_attempts x
         where x.application_id = app.id and x.stage_id = v_stage_id
           for update;
        if not found then
          insert into public.work_attempts (application_id, stage_id, user_id, open_until)
          values (app.id, v_stage_id, app.user_id, now());
        elsif wa.started_at is null and wa.submitted_at is null then
          perform set_config('chase.work_reopen', 'on', true);
          update public.work_attempts set unlocked_at = now(), open_until = now() where id = wa.id;
          perform set_config('chase.work_reopen', 'off', true);
        elsif wa.submitted_at is null and next_stage = app.stage then
          next_status := 'in_progress';
        end if;
      end if;
    end if;

    update public.applications set stage = next_stage, status = next_status where id = app.id;
  elsif p_decision = 'reject' then
    update public.applications set status = 'rejected' where id = app.id;
  else
    update public.applications set status = 'awaiting_review' where id = app.id;
  end if;

  return decision_id;
end;
$$;
revoke execute on function public.admin_decide(uuid, text, text) from public, anon;
grant execute on function public.admin_decide(uuid, text, text) to authenticated;

-- ───────────────────────── Submit (service role only) ─────────────────────────
-- One transaction: insert the frozen submission (submission_guard re-checks start, deadline and
-- double submits on the DB clock), stamp work_attempts.submitted_at (work_attempt_guard checks the
-- deadline again), close any open persona chat for the attempt, and mark the application
-- 'submitted'. The application keeps its stage: only an admin decision (admin_decide) moves it on,
-- and a status other than in_progress/advanced (an admin hold, a rejection) is left alone.
create or replace function public.work_submit(
  p_attempt_id uuid,
  p_user_id uuid,
  p_submission_id uuid,
  p_fields jsonb
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  a record;
  sid uuid;
begin
  select wa.id, wa.user_id, wa.application_id, wa.submitted_at, ws.key, ws.app_stage
    into a
    from public.work_attempts wa
    join public.work_stages ws on ws.id = wa.stage_id
   where wa.id = p_attempt_id
     for update of wa;
  if not found or a.user_id <> p_user_id then
    raise exception 'work_attempt_not_found' using errcode = 'P0002';
  end if;
  if a.submitted_at is not null then
    raise exception 'work_already_submitted' using errcode = 'P0001';
  end if;

  insert into public.submissions (
    id, attempt_id, user_id, stage_key, files, repo_url, repo_commit_sha, deployed_url, mvp_url,
    loom_url, loom_transcript, test_logins, extracted_text, sanitised_text, word_count,
    word_count_total, page_count, injection_flags, review_flags, snapshot, grading_status)
  values (
    coalesce(p_submission_id, gen_random_uuid()),
    a.id,
    p_user_id,
    a.key,
    coalesce(array(select jsonb_array_elements_text(coalesce(p_fields -> 'files', '[]'::jsonb))), '{}'::text[]),
    nullif(p_fields ->> 'repo_url', ''),
    -- Resolved just before the freeze, so later pushes are never graded.
    case when p_fields ->> 'repo_commit_sha' ~ '^[0-9a-f]{40}$' then p_fields ->> 'repo_commit_sha' end,
    nullif(p_fields ->> 'deployed_url', ''),
    nullif(p_fields ->> 'mvp_url', ''),
    nullif(p_fields ->> 'loom_url', ''),
    nullif(p_fields ->> 'loom_transcript', ''),
    nullif(p_fields ->> 'test_logins', ''),
    p_fields ->> 'extracted_text',
    p_fields ->> 'sanitised_text',
    (p_fields ->> 'word_count')::int,
    (p_fields ->> 'word_count_total')::int,
    (p_fields ->> 'page_count')::int,
    coalesce(p_fields -> 'injection_flags', '[]'::jsonb),
    case when jsonb_typeof(p_fields -> 'review_flags') = 'array' then p_fields -> 'review_flags' else '[]'::jsonb end,
    case when jsonb_typeof(p_fields -> 'repo_snapshot') = 'object'
         then jsonb_build_object('repo', p_fields -> 'repo_snapshot') else '{}'::jsonb end,
    'pending')
  returning id into sid;

  update public.work_attempts set submitted_at = now() where id = a.id;

  update public.persona_sessions set ended_at = now() where attempt_id = a.id and ended_at is null;

  update public.applications
     set status = 'submitted'
   where id = a.application_id
     and stage = a.app_stage
     and status in ('in_progress', 'advanced');

  return sid;
end;
$$;
revoke execute on function public.work_submit(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.work_submit(uuid, uuid, uuid, jsonb) to service_role;
