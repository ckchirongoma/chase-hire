-- Wave 2: AI CV-verification interview, role quiz, and the shared grading tables.
-- Candidate-facing reads go through the API (service role after an auth check) or the
-- my_results() RPC, so these tables only have admin SELECT policies. That keeps
-- grader evidence, verification concerns and answer keys away from candidates.

-- ───────────────────────── Stage transitions ─────────────────────────
-- Stages: interview → quiz → work_1 → work_2 → shortlist → live → offer → closed.
-- Only interview → quiz happens automatically (when the interview ends). Every other
-- stage move, and every move to advanced/rejected, needs an admin decision row written
-- in the same transaction (admin_decide).
create or replace function public.applications_status_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  has_decision boolean;
begin
  if tg_op = 'INSERT' then
    if new.status in ('advanced', 'rejected') then
      raise exception 'status_change_requires_admin_decision' using errcode = 'P0001';
    end if;
    if new.stage <> 'interview' then
      raise exception 'application_must_start_at_interview' using errcode = 'P0001';
    end if;
    return new;
  end if;

  select exists (
    select 1 from public.decisions d where d.application_id = new.id and d.decided_at = now()
  ) into has_decision;

  if new.status in ('advanced', 'rejected') and new.status is distinct from old.status then
    if not exists (
      select 1 from public.decisions d
      where d.application_id = new.id and d.decided_at = now()
        and d.decision = case new.status when 'advanced' then 'advance' else 'reject' end
    ) then
      raise exception 'status_change_requires_admin_decision' using errcode = 'P0001';
    end if;
  end if;

  if old.status = 'rejected' and new.status <> 'rejected' and not has_decision then
    raise exception 'status_change_requires_admin_decision' using errcode = 'P0001';
  end if;

  if new.stage is distinct from old.stage then
    if not (old.stage = 'interview' and new.stage = 'quiz' and new.status = 'in_progress')
       and not exists (
         select 1 from public.decisions d
         where d.application_id = new.id and d.decided_at = now() and d.decision = 'advance')
    then
      raise exception 'stage_change_requires_admin_decision' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

-- ───────────────────────── Shared grading tables ─────────────────────────
create table public.rubrics (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  version int not null default 1,
  title text not null,
  -- [{key, title, weight, description, anchors:{"1","3","5"}, evidence_required, method:'llm'|'computed'}]
  criteria jsonb not null,
  generic_baseline text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (key, version)
);
alter table public.rubrics enable row level security;
create policy rubrics_admin_select on public.rubrics for select to authenticated using (public.is_admin());
create policy rubrics_admin_update on public.rubrics for update to authenticated using (public.is_admin()) with check (public.is_admin());
grant select on public.rubrics to authenticated;
grant update (generic_baseline, active) on public.rubrics to authenticated;

-- One row per criterion per sample (3 samples, median taken in grade_summaries).
create table public.grades (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('interview', 'submission', 'gold')),
  subject_id uuid not null,
  rubric_id uuid not null references public.rubrics (id),
  criterion_key text not null,
  sample_idx int not null check (sample_idx between 0 and 2),
  score numeric not null check (score between 1 and 5),
  evidence jsonb not null default '[]',      -- [{quote, location}]
  rationale text not null,
  extra jsonb not null default '{}',         -- reference_mapping, red_flags_triggered, extra_valid_gaps, feedback
  model text not null,
  prompt_version text not null,
  temperature numeric not null,
  created_at timestamptz not null default now(),
  unique (subject_type, subject_id, rubric_id, criterion_key, sample_idx)
);
alter table public.grades enable row level security;
create index grades_subject_idx on public.grades (subject_type, subject_id);
create policy grades_admin_select on public.grades for select to authenticated using (public.is_admin());
grant select on public.grades to authenticated;

create table public.grade_summaries (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('interview', 'submission', 'gold')),
  subject_id uuid not null,
  rubric_id uuid not null references public.rubrics (id),
  criterion_key text not null,
  weight numeric not null default 0,
  median_score numeric check (median_score between 1 and 5),
  spread numeric,
  needs_human_review boolean not null default false,
  review_reason text,
  human_score numeric check (human_score between 1 and 5),
  human_reason text,
  human_by uuid references auth.users (id),
  human_at timestamptz,
  final_score numeric check (final_score between 1 and 5),
  feedback text,                              -- short, candidate-safe
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subject_type, subject_id, criterion_key),
  check (human_score is null or length(btrim(coalesce(human_reason, ''))) >= 20)
);
alter table public.grade_summaries enable row level security;
create trigger grade_summaries_updated_at before update on public.grade_summaries
  for each row execute function public.set_updated_at();
create policy grade_summaries_admin_select on public.grade_summaries for select to authenticated using (public.is_admin());
create policy grade_summaries_admin_update on public.grade_summaries for update to authenticated using (public.is_admin()) with check (public.is_admin());
grant select on public.grade_summaries to authenticated;
grant update (human_score, human_reason, human_by, human_at, final_score, needs_human_review) on public.grade_summaries to authenticated;

create table public.grading_jobs (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('interview', 'submission', 'gold')),
  subject_id uuid not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subject_type, subject_id)
);
alter table public.grading_jobs enable row level security;
create trigger grading_jobs_updated_at before update on public.grading_jobs
  for each row execute function public.set_updated_at();
create policy grading_jobs_admin_select on public.grading_jobs for select to authenticated using (public.is_admin());
grant select on public.grading_jobs to authenticated;

-- ───────────────────────── AI CV-verification interview ─────────────────────────
create table public.interview_sessions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.applications (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  plan jsonb not null,                        -- script built from the parsed CV
  progress jsonb not null default '{}',       -- server-side cursor through the script
  started_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason in ('completed', 'timeout')),
  summary jsonb,                              -- grader output incl. verification_concerns (admin only)
  score numeric check (score between 0 and 100),
  model text,
  prompt_version text,
  created_at timestamptz not null default now()
);
alter table public.interview_sessions enable row level security;
create policy interview_sessions_admin_select on public.interview_sessions for select to authenticated using (public.is_admin());
grant select on public.interview_sessions to authenticated;

create or replace function public.interview_session_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.started_at := now();
    new.deadline_at := now() + interval '25 minutes';
    return new;
  end if;
  if new.started_at <> old.started_at or new.deadline_at <> old.deadline_at
     or new.application_id <> old.application_id or new.user_id <> old.user_id then
    raise exception 'interview_session_immutable' using errcode = 'P0001';
  end if;
  if old.ended_at is not null and new.ended_at is distinct from old.ended_at then
    raise exception 'interview_already_ended' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger interview_sessions_guard before insert or update on public.interview_sessions
  for each row execute function public.interview_session_guard();

create table public.interview_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.interview_sessions (id) on delete cascade,
  role text not null check (role in ('interviewer', 'candidate')),
  content text not null check (length(content) between 1 and 6000),
  step text,                                  -- warmup|claim|probe|situational|logistics|close|redirect
  claim_id text,
  meta jsonb not null default '{}',           -- e.g. JEV probabilities that chose a probe
  created_at timestamptz not null default now()
);
alter table public.interview_messages enable row level security;
create index interview_messages_session_idx on public.interview_messages (session_id, created_at);
create policy interview_messages_admin_select on public.interview_messages for select to authenticated using (public.is_admin());
grant select on public.interview_messages to authenticated;

-- Candidate answers after the deadline (plus 5 s grace) or after the end are refused.
create or replace function public.interview_message_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  s record;
begin
  new.created_at := now();
  if new.role = 'candidate' then
    select ended_at, deadline_at into s from public.interview_sessions where id = new.session_id;
    if s.ended_at is not null or now() > s.deadline_at + interval '5 seconds' then
      raise exception 'interview_deadline_passed' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger interview_messages_guard before insert on public.interview_messages
  for each row execute function public.interview_message_guard();

insert into public.rubrics (key, version, title, criteria) values
('interview', 1, 'AI CV-verification interview', '[
  {"key":"specificity","title":"Specificity","weight":1,"method":"llm","evidence_required":true,
   "description":"How concrete and specific the answers are.",
   "anchors":{"1":"Generic, could be anyone''s","3":"Some concrete detail (tools, numbers)","5":"Precise detail: names systems, numbers, dates, trade-offs; consistent with the CV"}},
  {"key":"ownership","title":"Ownership","weight":1,"method":"llm","evidence_required":true,
   "description":"Whether the candidate separates their own contribution from the team''s.",
   "anchors":{"1":"\"We\" throughout, can''t separate own contribution","3":"Partly separates own work","5":"Clearly states own decisions and actions, and acknowledges others"}},
  {"key":"depth_under_probe","title":"Depth under probe","weight":1,"method":"llm","evidence_required":true,
   "description":"What happens to answers when probed.",
   "anchors":{"1":"Answer collapses on the first probe","3":"Holds up on one probe","5":"Gets more specific under probing; describes failures and what was rejected"}},
  {"key":"cv_consistency","title":"CV consistency","weight":1,"method":"llm","evidence_required":true,
   "description":"Consistency between answers and the parsed CV (dates, scope, tools).",
   "anchors":{"1":"Contradicts the CV (dates, scope, tools)","3":"Minor gaps","5":"Fully consistent"}},
  {"key":"situational_judgement","title":"Situational judgement","weight":1,"method":"llm","evidence_required":true,
   "description":"Answer to the role-specific situational question.",
   "anchors":{"1":"Jumps to a solution","3":"Reasonable plan","5":"Diagnoses first, sequences risk, names what they''d check"}},
  {"key":"communication","title":"Communication","weight":1,"method":"llm","evidence_required":true,
   "description":"Structure and clarity of the written answers. Do not penalise second-language English.",
   "anchors":{"1":"Rambling, no structure","3":"Understandable","5":"Answer-first, concise, structured"}}
]'::jsonb);

-- ───────────────────────── Role quiz ─────────────────────────
create table public.quiz_items (
  id uuid primary key default gen_random_uuid(),
  role_slug text not null references public.roles (slug) on update cascade,
  topic text not null,
  stem text not null,
  options jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 4 and 5),
  answer_key int[] not null check (cardinality(answer_key) >= 1),
  multi boolean not null default false,        -- "select all that apply": all-or-nothing
  version int not null default 1,
  active boolean not null default true,
  exposures int not null default 0,
  difficulty_p numeric,
  created_at timestamptz not null default now(),
  check (multi or cardinality(answer_key) = 1)
);
alter table public.quiz_items enable row level security;
create index quiz_items_role_idx on public.quiz_items (role_slug, topic) where active;
create policy quiz_items_admin_select on public.quiz_items for select to authenticated using (public.is_admin());
create policy quiz_items_admin_update on public.quiz_items for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy quiz_items_admin_insert on public.quiz_items for insert to authenticated with check (public.is_admin());
grant select, insert on public.quiz_items to authenticated;
grant update (topic, stem, options, answer_key, multi, active) on public.quiz_items to authenticated;

create table public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.applications (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  seed bigint not null,
  item_count int not null default 15,
  started_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  submitted_at timestamptz,
  raw_score int check (raw_score between 0 and 15),
  pct numeric check (pct between 0 and 100),
  topic_scores jsonb,                          -- {topic: {correct, total}}
  below_flag boolean,
  created_at timestamptz not null default now(),
  check (deadline_at > started_at)
);
alter table public.quiz_attempts enable row level security;
create policy quiz_attempts_admin_select on public.quiz_attempts for select to authenticated using (public.is_admin());
grant select on public.quiz_attempts to authenticated;

create or replace function public.quiz_attempt_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.started_at := now();
    new.deadline_at := now() + interval '12 minutes';
    return new;
  end if;
  if old.submitted_at is not null then
    raise exception 'quiz_attempt_already_submitted' using errcode = 'P0001';
  end if;
  if new.started_at <> old.started_at or new.deadline_at <> old.deadline_at
     or new.user_id <> old.user_id or new.seed <> old.seed then
    raise exception 'quiz_attempt_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger quiz_attempts_guard before insert or update on public.quiz_attempts
  for each row execute function public.quiz_attempt_guard();

create table public.quiz_responses (
  attempt_id uuid not null references public.quiz_attempts (id) on delete cascade,
  position int not null check (position between 1 and 15),
  item_id uuid not null references public.quiz_items (id),
  topic text not null,
  rendered jsonb not null,                    -- {stem, options, multi}
  answer_key int[] not null,
  served_at timestamptz,
  answered_at timestamptz,
  answer int[],
  correct boolean,
  primary key (attempt_id, position)
);
alter table public.quiz_responses enable row level security;
create policy quiz_responses_admin_select on public.quiz_responses for select to authenticated using (public.is_admin());
grant select on public.quiz_responses to authenticated;

create or replace function public.quiz_response_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  a record;
begin
  if new.answer_key <> old.answer_key or new.rendered <> old.rendered then
    raise exception 'quiz_item_immutable' using errcode = 'P0001';
  end if;
  if old.answered_at is not null then
    if new.answered_at is distinct from old.answered_at or new.answer is distinct from old.answer then
      raise exception 'quiz_item_already_answered' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.answered_at is not null then
    if old.served_at is null then
      raise exception 'quiz_item_not_served' using errcode = 'P0001';
    end if;
    select deadline_at, submitted_at into a from public.quiz_attempts where id = new.attempt_id;
    if a.submitted_at is not null or now() > a.deadline_at + interval '5 seconds' then
      raise exception 'quiz_deadline_passed' using errcode = 'P0001';
    end if;
    new.answered_at := now();
    -- All-or-nothing: the chosen set must equal the key set.
    new.correct := new.answer is not null and cardinality(new.answer) > 0 and
      (select array_agg(distinct x order by x) from unnest(new.answer) x) =
      (select array_agg(distinct x order by x) from unnest(new.answer_key) x);
  elsif new.answer is not null then
    raise exception 'quiz_answer_requires_answered_at' using errcode = 'P0001';
  end if;
  if old.served_at is not null and new.served_at is distinct from old.served_at then
    raise exception 'quiz_item_already_served' using errcode = 'P0001';
  end if;
  if old.served_at is null and new.served_at is not null then
    new.served_at := now();
  end if;
  return new;
end;
$$;
create trigger quiz_responses_guard before update on public.quiz_responses
  for each row execute function public.quiz_response_guard();

-- ───────────────────────── Admin decision (stage-aware) ─────────────────────────
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
    -- Releasing a below-hurdle hold before the interview keeps the stage; otherwise move on.
    if app.stage = 'interview' and not exists (
      select 1 from public.interview_sessions s where s.application_id = app.id and s.ended_at is not null
    ) then
      next_stage := 'interview';
    else
      next_stage := case app.stage
        when 'interview' then 'quiz' when 'quiz' then 'work_1' when 'work_1' then 'work_2'
        when 'work_2' then 'shortlist' when 'grading' then 'shortlist' when 'shortlist' then 'live'
        when 'live' then 'offer' when 'offer' then 'closed' else app.stage end;
    end if;
    update public.applications set stage = next_stage, status = 'advanced' where id = app.id;
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

-- Scores visible at decision time (also used for the admin pipeline).
-- Later waves extend this with work-assessment and live scores.
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
      from public.quiz_attempts q where q.application_id = a.id and q.submitted_at is not null)
  )
  from public.applications a where a.id = p_application_id;
$$;
revoke execute on function public.application_scores(uuid) from public, anon, authenticated;

-- Candidate results: own applications only, candidate-safe fields only.
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

revoke execute on function public.interview_session_guard() from public, anon, authenticated;
revoke execute on function public.interview_message_guard() from public, anon, authenticated;
revoke execute on function public.quiz_attempt_guard() from public, anon, authenticated;
revoke execute on function public.quiz_response_guard() from public, anon, authenticated;
