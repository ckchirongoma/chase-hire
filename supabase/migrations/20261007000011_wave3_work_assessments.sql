-- Wave 3: work assessments (BA Part 1/2, SWE Test 1/2), the BA stakeholder persona,
-- submissions with snapshots, the SWE Test 1 verification harness, and storage buckets.
-- As in Wave 2, candidates read through the API or my_results(); tables are admin-SELECT only.

-- Rubrics carry their answer-key / reference material for reference-guided grading.
alter table public.rubrics add column if not exists reference jsonb not null default '{}';

-- ───────────────────────── Stage configuration ─────────────────────────
create table public.work_stages (
  id uuid primary key default gen_random_uuid(),
  role_slug text not null references public.roles (slug) on update cascade,
  key text not null unique check (key in ('ba_part1', 'ba_part2', 'swe_test1', 'swe_test2')),
  app_stage text not null check (app_stage in ('work_1', 'work_2')),
  title text not null,
  brief_md text not null,
  intended_effort text not null,
  open_window interval not null default interval '7 days',
  work_window interval not null,
  dataset_bundle text,                 -- storage prefix in the datasets bucket, e.g. 'v1/bundle_a'
  rubric_key text not null,
  word_limit int,                      -- body words (excluding appendices); null = none
  page_limit int,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (role_slug, app_stage)
);
alter table public.work_stages enable row level security;
-- Stage briefs are shown to candidates; nothing secret lives here.
create policy work_stages_read on public.work_stages for select to authenticated using (active or public.is_admin());
create policy work_stages_admin_update on public.work_stages for update to authenticated using (public.is_admin()) with check (public.is_admin());
grant select on public.work_stages to authenticated;
grant update (title, brief_md, intended_effort, open_window, work_window, dataset_bundle, word_limit, page_limit, active)
  on public.work_stages to authenticated;

-- ───────────────────────── Attempts and submissions ─────────────────────────
create table public.work_attempts (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,
  stage_id uuid not null references public.work_stages (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  unlocked_at timestamptz not null default now(),
  open_until timestamptz not null,     -- must press Start before this
  started_at timestamptz,
  deadline_at timestamptz,             -- started_at + work_window (DB clock)
  submitted_at timestamptz,
  draft jsonb not null default '{}',   -- autosaved form fields
  draft_saved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (application_id, stage_id)
);
alter table public.work_attempts enable row level security;
create policy work_attempts_admin_select on public.work_attempts for select to authenticated using (public.is_admin());
grant select on public.work_attempts to authenticated;

create or replace function public.work_attempt_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  st record;
begin
  select open_window, work_window into st from public.work_stages where id = new.stage_id;
  if tg_op = 'INSERT' then
    new.unlocked_at := now();
    new.open_until := now() + st.open_window;
    new.started_at := null;
    new.deadline_at := null;
    new.submitted_at := null;
    return new;
  end if;

  if new.unlocked_at <> old.unlocked_at or new.open_until <> old.open_until
     or new.application_id <> old.application_id or new.stage_id <> old.stage_id or new.user_id <> old.user_id then
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
create trigger work_attempts_guard before insert or update on public.work_attempts
  for each row execute function public.work_attempt_guard();

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null unique references public.work_attempts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  stage_key text not null,
  files text[] not null default '{}',          -- storage paths in the submissions bucket
  repo_url text,
  repo_commit_sha text,
  deployed_url text,
  mvp_url text,
  loom_url text,
  loom_transcript text,
  test_logins text,
  snapshot jsonb not null default '{}',        -- {captured_at, urls:{url:{status, final_url, sha256, path}}, repo:{sha, error}}
  extracted_text text,
  sanitised_text text,
  word_count int,
  page_count int,
  injection_flags jsonb not null default '[]',
  score numeric check (score between 0 and 100),  -- weighted stage score once graded
  grading_status text not null default 'pending' check (grading_status in ('pending', 'queued', 'running', 'done', 'failed', 'needs_review')),
  created_at timestamptz not null default now()
);
alter table public.submissions enable row level security;
create policy submissions_admin_select on public.submissions for select to authenticated using (public.is_admin());
grant select on public.submissions to authenticated;

-- A submission row can only be written for a started, unexpired, unsubmitted attempt.
create or replace function public.submission_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  a record;
begin
  if tg_op = 'INSERT' then
    select started_at, deadline_at, submitted_at, user_id into a from public.work_attempts where id = new.attempt_id;
    if a.started_at is null then
      raise exception 'work_not_started' using errcode = 'P0001';
    end if;
    if a.submitted_at is not null then
      raise exception 'work_already_submitted' using errcode = 'P0001';
    end if;
    if now() > a.deadline_at + interval '5 seconds' then
      raise exception 'work_deadline_passed' using errcode = 'P0001';
    end if;
    if new.user_id <> a.user_id then
      raise exception 'submission_user_mismatch' using errcode = 'P0001';
    end if;
    new.created_at := now();
    return new;
  end if;
  -- Candidate-provided content is frozen; only grading/snapshot fields may change later.
  if new.files <> old.files or new.repo_url is distinct from old.repo_url
     or new.deployed_url is distinct from old.deployed_url or new.mvp_url is distinct from old.mvp_url
     or new.loom_url is distinct from old.loom_url or new.loom_transcript is distinct from old.loom_transcript
     or new.test_logins is distinct from old.test_logins or new.attempt_id <> old.attempt_id
     or new.user_id <> old.user_id or new.created_at <> old.created_at then
    raise exception 'submission_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger submissions_guard before insert or update on public.submissions
  for each row execute function public.submission_guard();

-- ───────────────────────── BA Part 1 stakeholder persona ─────────────────────────
create table public.persona_facts (
  persona_key text not null,
  id text not null,                    -- H01..H14
  fact text not null,
  triggers text[] not null,
  weight int not null check (weight between 1 and 3),
  volunteer_on text,                   -- e.g. 'sales_or_goals' for H12
  primary key (persona_key, id)
);
alter table public.persona_facts enable row level security;
create policy persona_facts_admin_select on public.persona_facts for select to authenticated using (public.is_admin());
create policy persona_facts_admin_update on public.persona_facts for update to authenticated using (public.is_admin()) with check (public.is_admin());
grant select on public.persona_facts to authenticated;
grant update (fact, triggers, weight, volunteer_on) on public.persona_facts to authenticated;

insert into public.persona_facts (persona_key, id, fact, triggers, weight, volunteer_on) values
('lerato', 'H01', 'Customer contact details? The agents keep those in their own sheets. The base from the Network doesn''t have them.', array['where contacts come from','how agents reach customers','phone or email source'], 3, null),
('lerato', 'H02', 'The base is a monthly Power BI export from the Network. We can''t change its columns, we just get what we get.', array['data source','refresh','who owns the extract'], 2, null),
('lerato', 'H03', 'Technically the customer data is the Network''s. Our dealer agreement lets us contact them about Network products, renewals and upgrades.', array['data ownership','permission to contact','legal basis','dealer agreement'], 3, null),
('lerato', 'H04', 'Legal keeps an opt-out and ''under legal review'' list in a separate spreadsheet. It''s by company name, not account number.', array['opt-outs','do-not-contact','complaints','legal'], 3, null),
('lerato', 'H05', 'The dialler has no API. They said they can do a nightly CSV export and they connect to Power BI.', array['telephony','call data','integrations','dialler'], 2, null),
('lerato', 'H06', 'The WhatsApp and SMS platform is the Network''s. Templates need their approval; last time it took about a week.', array['messaging platform','WhatsApp setup','sender','templates'], 2, null),
('lerato', 'H07', 'Customers can upgrade from three months before contract end, but a few price plans only allow it in the last month.', array['eligibility','upgrade rules','when can they renew'], 2, null),
('lerato', 'H08', 'Agents earn commission per upgrade, so honestly they don''t love sharing their sheets.', array['incentives','why data isn''t shared','agent behaviour','commission'], 2, null),
('lerato', 'H09', 'The contract status column is whatever it was on the day the Network ran the report.', array['data freshness','status accuracy','how status is calculated'], 2, null),
('lerato', 'H10', 'One account manager owns the entire base. If he''s on leave, nothing moves.', array['ownership','who manages accounts','escalation'], 1, null),
('lerato', 'H11', 'We did a bulk SMS blast last year. We got complaints, and the Network threatened to suspend our sender.', array['past attempts','what went wrong','complaints','history'], 3, null),
('lerato', 'H12', 'My target is to double upgrades per month. I don''t need another dashboard.', array['goals','success','targets','KPIs','sales'], 1, 'sales_or_goals'),
('lerato', 'H13', 'Half the time the contact person is a bookkeeper or receptionist, not the person who decides.', array['who you talk to','decision makers','contact quality'], 2, null),
('lerato', 'H14', 'Lines that port out just vanish from the next month''s base. Nobody tells us.', array['churn','lines disappearing','month-to-month changes'], 2, null);

create table public.persona_sessions (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null unique references public.work_attempts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  persona_key text not null default 'lerato',
  started_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  ended_at timestamptz,
  candidate_messages int not null default 0,
  revealed_fact_ids text[] not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.persona_sessions enable row level security;
create policy persona_sessions_admin_select on public.persona_sessions for select to authenticated using (public.is_admin());
grant select on public.persona_sessions to authenticated;

create or replace function public.persona_session_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  a record;
begin
  if tg_op = 'INSERT' then
    select started_at, deadline_at, submitted_at into a from public.work_attempts where id = new.attempt_id;
    if a.started_at is null or a.submitted_at is not null or now() > a.deadline_at then
      raise exception 'work_not_active' using errcode = 'P0001';
    end if;
    new.started_at := now();
    -- 25-minute chat, never beyond the stage deadline.
    new.deadline_at := least(now() + interval '25 minutes', a.deadline_at);
    return new;
  end if;
  if new.started_at <> old.started_at or new.deadline_at <> old.deadline_at or new.attempt_id <> old.attempt_id then
    raise exception 'persona_session_immutable' using errcode = 'P0001';
  end if;
  if old.ended_at is not null and new.ended_at is distinct from old.ended_at then
    raise exception 'persona_session_ended' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger persona_sessions_guard before insert or update on public.persona_sessions
  for each row execute function public.persona_session_guard();

create table public.persona_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.persona_sessions (id) on delete cascade,
  role text not null check (role in ('candidate', 'persona')),
  content text not null check (length(content) between 1 and 4000),
  revealed_fact_ids text[] not null default '{}',
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.persona_messages enable row level security;
create index persona_messages_session_idx on public.persona_messages (session_id, created_at);
create policy persona_messages_admin_select on public.persona_messages for select to authenticated using (public.is_admin());
grant select on public.persona_messages to authenticated;

-- Candidate messages: before the chat deadline (+5 s), at most 25, and the counter is kept by the DB.
create or replace function public.persona_message_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  s record;
begin
  new.created_at := now();
  if new.role = 'candidate' then
    select ended_at, deadline_at, candidate_messages into s from public.persona_sessions where id = new.session_id for update;
    if s.ended_at is not null or now() > s.deadline_at + interval '5 seconds' then
      raise exception 'persona_chat_closed' using errcode = 'P0001';
    end if;
    if s.candidate_messages >= 25 then
      raise exception 'persona_message_cap' using errcode = 'P0001';
    end if;
    update public.persona_sessions set candidate_messages = candidate_messages + 1 where id = new.session_id;
  elsif cardinality(new.revealed_fact_ids) > 0 then
    update public.persona_sessions
    set revealed_fact_ids = (select array_agg(distinct x order by x) from unnest(revealed_fact_ids || new.revealed_fact_ids) x)
    where id = new.session_id;
  end if;
  return new;
end;
$$;
create trigger persona_messages_guard before insert on public.persona_messages
  for each row execute function public.persona_message_guard();

-- ───────────────────────── SWE Test 1 verification harness ─────────────────────────
create table public.verification_runs (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions (id) on delete cascade,
  check_key text not null,             -- R1..R7, U1..U8, M1..M7, D-a..D-c
  passed boolean,                      -- null = not run / informational
  manual boolean not null default false,
  detail jsonb not null default '{}',
  ran_at timestamptz not null default now(),
  ran_by uuid references auth.users (id)
);
alter table public.verification_runs enable row level security;
create index verification_runs_submission_idx on public.verification_runs (submission_id, check_key, ran_at desc);
create policy verification_runs_admin_select on public.verification_runs for select to authenticated using (public.is_admin());
create policy verification_runs_admin_insert on public.verification_runs for insert to authenticated
  with check (public.is_admin() and manual and ran_by = auth.uid());
grant select on public.verification_runs to authenticated;
grant insert (submission_id, check_key, passed, manual, detail, ran_by) on public.verification_runs to authenticated;

-- ───────────────────────── Storage ─────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('submissions', 'submissions', false, 20971520, array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/markdown', 'text/plain', 'image/png', 'image/jpeg']),
  ('datasets', 'datasets', false, 52428800, null),
  ('snapshots', 'snapshots', false, 10485760, null),
  ('gold', 'gold', false, 20971520, null)
on conflict (id) do nothing;

-- Candidates upload work files into submissions/{user_id}/...; everything else is server-side.
create policy submissions_owner_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'submissions' and (storage.foldername(name))[1] = auth.uid()::text);
create policy submissions_owner_read on storage.objects
  for select to authenticated
  using (bucket_id = 'submissions' and (storage.foldername(name))[1] = auth.uid()::text);
create policy work_buckets_admin_read on storage.objects
  for select to authenticated
  using (bucket_id in ('submissions', 'datasets', 'snapshots', 'gold') and public.is_admin());
create policy gold_admin_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'gold' and public.is_admin());

-- ───────────────────────── Stage seeds (briefs rendered verbatim from docs 06-08) ─────────────────────────
-- Brief text is seeded by the Wave 3 content migration (20261007000013); rows are created there.

-- ───────────────────────── Scores (extends Wave 2 versions) ─────────────────────────
create or replace function public.application_scores(p_application_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'application', jsonb_build_object(
      'stage', a.stage, 'status', a.status, 'below_hurdle', a.below_hurdle,
      'reasoning_stars', a.reasoning_stars, 'composite_score', a.composite_score),
    'reasoning', (
      select jsonb_build_object('raw_score', r.raw_score, 'percentile', r.percentile,
                                'stars', r.stars, 'norm_version', r.norm_version)
      from public.reasoning_attempts r
      where r.user_id = a.user_id and r.form = 'online' and r.submitted_at is not null
      order by r.started_at desc limit 1),
    'interview', (
      select jsonb_build_object('score', s.score, 'ended_at', s.ended_at, 'end_reason', s.end_reason)
      from public.interview_sessions s where s.application_id = a.id),
    'quiz', (
      select jsonb_build_object('pct', q.pct, 'raw_score', q.raw_score, 'below_flag', q.below_flag,
                                'topic_scores', q.topic_scores)
      from public.quiz_attempts q where q.application_id = a.id and q.submitted_at is not null),
    'work', (
      select coalesce(jsonb_object_agg(ws.key, jsonb_build_object(
        'app_stage', ws.app_stage, 'submitted_at', wa.submitted_at, 'score', sub.score,
        'grading_status', sub.grading_status,
        'criteria', (
          select coalesce(jsonb_object_agg(g.criterion_key, g.final_score), '{}'::jsonb)
          from public.grade_summaries g
          where g.subject_type = 'submission' and g.subject_id = sub.id and position('.' in g.criterion_key) = 0))),
        '{}'::jsonb)
      from public.work_attempts wa
      join public.work_stages ws on ws.id = wa.stage_id
      left join public.submissions sub on sub.attempt_id = wa.id
      where wa.application_id = a.id)
  )
  from public.applications a where a.id = p_application_id;
$$;
revoke execute on function public.application_scores(uuid) from public, anon, authenticated;

create or replace function public.my_results()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'application_id', a.id,
    'role_slug', r.slug,
    'role_title', r.title,
    'stage', a.stage,
    'status', a.status,
    'below_hurdle', a.below_hurdle,
    'created_at', a.created_at,
    'interview', (
      select jsonb_build_object(
        'started_at', s.started_at, 'ended_at', s.ended_at, 'end_reason', s.end_reason,
        'score', s.score,
        'criteria', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'key', g.criterion_key, 'final_score', g.final_score, 'feedback', g.feedback,
            'under_review', g.needs_human_review and g.human_score is null)), '[]'::jsonb)
          from public.grade_summaries g
          where g.subject_type = 'interview' and g.subject_id = s.id))
      from public.interview_sessions s where s.application_id = a.id),
    'quiz', (
      select jsonb_build_object('started_at', q.started_at, 'submitted_at', q.submitted_at,
                                'raw_score', q.raw_score, 'pct', q.pct, 'topic_scores', q.topic_scores)
      from public.quiz_attempts q where q.application_id = a.id),
    'work', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'stage_key', ws.key, 'app_stage', ws.app_stage, 'title', ws.title,
        'open_until', wa.open_until, 'started_at', wa.started_at, 'deadline_at', wa.deadline_at,
        'submitted_at', wa.submitted_at,
        'score', sub.score,
        'grading_status', sub.grading_status,
        'criteria', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'key', g.criterion_key, 'final_score', g.final_score, 'feedback', g.feedback,
            'under_review', g.needs_human_review and g.human_score is null)
            order by g.criterion_key), '[]'::jsonb)
          from public.grade_summaries g
          where g.subject_type = 'submission' and g.subject_id = sub.id
            and position('.' in g.criterion_key) = 0))
        order by ws.app_stage), '[]'::jsonb)
      from public.work_attempts wa
      join public.work_stages ws on ws.id = wa.stage_id
      left join public.submissions sub on sub.attempt_id = wa.id
      where wa.application_id = a.id),
    'decisions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'stage', d.stage, 'decision', d.decision, 'reason', d.reason, 'decided_at', d.decided_at)
        order by d.decided_at desc), '[]'::jsonb)
      from public.decisions d where d.application_id = a.id)
  ) order by a.created_at), '[]'::jsonb)
  from public.applications a
  join public.roles r on r.id = a.role_id
  where a.user_id = auth.uid();
$$;
revoke execute on function public.my_results() from public, anon;
grant execute on function public.my_results() to authenticated;

revoke execute on function public.work_attempt_guard() from public, anon, authenticated;
revoke execute on function public.submission_guard() from public, anon, authenticated;
revoke execute on function public.persona_session_guard() from public, anon, authenticated;
revoke execute on function public.persona_message_guard() from public, anon, authenticated;
