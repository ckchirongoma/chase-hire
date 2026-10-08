-- Decisions of 8 Oct 2026 (product owner):
--   1. The AI CV screen is a spoken, adaptive conversation (~25-30 min, hard limit 35 min).
--      Typed answers only as an admin-approved accessibility accommodation.
--   2. Tab rule for the timed stages (reasoning, role quiz, AI interview): leaving the page
--      the first time pauses the stage (the candidate must confirm to continue); the second
--      time locks the session until an admin reopens it. Never an automatic rejection, and a
--      reopen gives back the time that was left when it locked.

-- ───────────────────────── Signals ─────────────────────────
alter table public.signals drop constraint if exists signals_kind_check;
alter table public.signals add constraint signals_kind_check check (kind in (
  'paste_attempt', 'copy_attempt', 'blur', 'focus', 'burst_input', 'answer_time', 'live_delta',
  'prompt_injection', 'tab_pause', 'session_locked', 'session_reopened'));

-- ───────────────────────── Lock columns ─────────────────────────
alter table public.reasoning_attempts
  add column if not exists tab_leaves int not null default 0,
  add column if not exists locked_at timestamptz,
  add column if not exists lock_reason text,
  add column if not exists reopen_count int not null default 0;
alter table public.quiz_attempts
  add column if not exists tab_leaves int not null default 0,
  add column if not exists locked_at timestamptz,
  add column if not exists lock_reason text,
  add column if not exists reopen_count int not null default 0;
alter table public.interview_sessions
  add column if not exists tab_leaves int not null default 0,
  add column if not exists locked_at timestamptz,
  add column if not exists lock_reason text,
  add column if not exists reopen_count int not null default 0,
  add column if not exists answer_mode text not null default 'voice' check (answer_mode in ('voice', 'typed'));

-- Accessibility accommodation: an admin may let one application answer the interview by typing.
alter table public.applications
  add column if not exists interview_answer_mode text not null default 'voice'
    check (interview_answer_mode in ('voice', 'typed')),
  add column if not exists interview_mode_reason text,
  add column if not exists interview_mode_set_by uuid references auth.users (id);

-- Candidates read their own reasoning attempts by column grant: expose the lock state too.
grant select (tab_leaves, locked_at) on public.reasoning_attempts to authenticated;

-- ───────────────────────── Guards (redefined; previous logic kept) ─────────────────────────
-- A reopen (admin_reopen_session) is the only way to move a deadline. It sets the
-- transaction-local flag chase.reopen = 'on', which these guards honour.

create or replace function public.reasoning_attempt_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.form = 'online' and exists (
      select 1 from public.reasoning_attempts a
      where a.user_id = new.user_id and a.form = 'online'
        and a.started_at > now() - interval '90 days'
    ) then
      raise exception 'reasoning_retake_too_soon' using errcode = 'P0001';
    end if;
    -- The DB clock owns the timer: 15 min online, 6 min for the live parallel form.
    new.started_at := now();
    new.deadline_at := now() + case when new.form = 'live' then interval '6 minutes'
                                    else interval '15 minutes' end;
    return new;
  end if;

  -- UPDATE: a submitted attempt is final.
  if old.submitted_at is not null then
    raise exception 'reasoning_attempt_already_submitted' using errcode = 'P0001';
  end if;
  if new.started_at <> old.started_at or new.user_id <> old.user_id or new.seed <> old.seed
     or (new.deadline_at <> old.deadline_at and coalesce(current_setting('chase.reopen', true), '') <> 'on') then
    raise exception 'reasoning_attempt_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function public.reasoning_response_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  a record;
begin
  if new.answer_key <> old.answer_key or new.rendered <> old.rendered or new.seed <> old.seed then
    raise exception 'reasoning_item_immutable' using errcode = 'P0001';
  end if;

  if old.answered_at is not null then
    if new.answered_at is distinct from old.answered_at or new.answer is distinct from old.answer then
      raise exception 'reasoning_item_already_answered' using errcode = 'P0001';
    end if;
    return new;
  end if;

  select deadline_at, submitted_at, locked_at into a
  from public.reasoning_attempts where id = new.attempt_id;
  if a.locked_at is not null and (new.answered_at is not null or new.served_at is distinct from old.served_at) then
    raise exception 'session_locked' using errcode = 'P0001';
  end if;

  if new.answered_at is not null then
    if old.served_at is null then
      raise exception 'reasoning_item_not_served' using errcode = 'P0001';
    end if;
    -- 5 s grace for network latency only.
    if a.submitted_at is not null or now() > a.deadline_at + interval '5 seconds' then
      raise exception 'reasoning_deadline_passed' using errcode = 'P0001';
    end if;
    new.answered_at := now();
    new.correct := (new.answer is not null and new.answer = new.answer_key);
  elsif new.answer is not null then
    raise exception 'reasoning_answer_requires_answered_at' using errcode = 'P0001';
  end if;

  if old.served_at is not null and new.served_at is distinct from old.served_at then
    raise exception 'reasoning_item_already_served' using errcode = 'P0001';
  end if;
  if old.served_at is null and new.served_at is not null then
    new.served_at := now();
  end if;
  return new;
end;
$$;

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
  if new.started_at <> old.started_at or new.user_id <> old.user_id or new.seed <> old.seed
     or (new.deadline_at <> old.deadline_at and coalesce(current_setting('chase.reopen', true), '') <> 'on') then
    raise exception 'quiz_attempt_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

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
  select deadline_at, submitted_at, locked_at into a from public.quiz_attempts where id = new.attempt_id;
  if a.locked_at is not null and (new.answered_at is not null or new.served_at is distinct from old.served_at) then
    raise exception 'session_locked' using errcode = 'P0001';
  end if;
  if new.answered_at is not null then
    if old.served_at is null then
      raise exception 'quiz_item_not_served' using errcode = 'P0001';
    end if;
    if a.submitted_at is not null or now() > a.deadline_at + interval '5 seconds' then
      raise exception 'quiz_deadline_passed' using errcode = 'P0001';
    end if;
    new.answered_at := now();
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

-- The spoken interview runs up to ~30 minutes; the hard limit is 35.
create or replace function public.interview_session_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.started_at := now();
    new.deadline_at := now() + interval '35 minutes';
    return new;
  end if;
  if new.started_at <> old.started_at or new.application_id <> old.application_id or new.user_id <> old.user_id
     or (new.deadline_at <> old.deadline_at and coalesce(current_setting('chase.reopen', true), '') <> 'on') then
    raise exception 'interview_session_immutable' using errcode = 'P0001';
  end if;
  if old.ended_at is not null and new.ended_at is distinct from old.ended_at then
    raise exception 'interview_already_ended' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

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
    select ended_at, deadline_at, locked_at into s from public.interview_sessions where id = new.session_id;
    if s.locked_at is not null then
      raise exception 'session_locked' using errcode = 'P0001';
    end if;
    if s.ended_at is not null or now() > s.deadline_at + interval '5 seconds' then
      raise exception 'interview_deadline_passed' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

-- ───────────────────────── Tab rule ─────────────────────────
-- Called by the server (service role) when the candidate's page reports it was hidden for at
-- least 2 seconds. First leave: 'paused'. Second: 'locked'. Already locked / finished: no-op.
create or replace function public.record_tab_leave(p_kind text, p_id uuid, p_user uuid, p_hidden_ms int)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  leaves int;
  locked timestamptz;
  finished boolean;
  owner uuid;
  ctx text;
begin
  if p_hidden_ms is null or p_hidden_ms < 2000 then
    return 'ignored';
  end if;
  if p_kind = 'reasoning' then
    select user_id, tab_leaves, locked_at, submitted_at is not null or now() > deadline_at + interval '5 seconds'
      into owner, leaves, locked, finished from public.reasoning_attempts where id = p_id for update;
  elsif p_kind = 'quiz' then
    select user_id, tab_leaves, locked_at, submitted_at is not null or now() > deadline_at + interval '5 seconds'
      into owner, leaves, locked, finished from public.quiz_attempts where id = p_id for update;
  elsif p_kind = 'interview' then
    select user_id, tab_leaves, locked_at, ended_at is not null or now() > deadline_at + interval '5 seconds'
      into owner, leaves, locked, finished from public.interview_sessions where id = p_id for update;
  else
    raise exception 'invalid_kind' using errcode = 'P0001';
  end if;
  if owner is null or owner <> p_user then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if finished then
    return 'ignored';
  end if;
  if locked is not null then
    return 'locked';
  end if;

  leaves := leaves + 1;
  ctx := p_kind;
  if p_kind = 'reasoning' then
    update public.reasoning_attempts set tab_leaves = leaves,
      locked_at = case when leaves >= 2 then now() end,
      lock_reason = case when leaves >= 2 then 'left the page twice' end
    where id = p_id;
  elsif p_kind = 'quiz' then
    update public.quiz_attempts set tab_leaves = leaves,
      locked_at = case when leaves >= 2 then now() end,
      lock_reason = case when leaves >= 2 then 'left the page twice' end
    where id = p_id;
  else
    update public.interview_sessions set tab_leaves = leaves,
      locked_at = case when leaves >= 2 then now() end,
      lock_reason = case when leaves >= 2 then 'left the page twice' end
    where id = p_id;
  end if;

  insert into public.signals (user_id, context, kind, payload)
  values (p_user, ctx, case when leaves >= 2 then 'session_locked' else 'tab_pause' end,
          jsonb_build_object('id', p_id, 'hidden_ms', p_hidden_ms, 'leaves', leaves));
  return case when leaves >= 2 then 'locked' else 'paused' end;
end;
$$;
revoke execute on function public.record_tab_leave(text, uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.record_tab_leave(text, uuid, uuid, int) to service_role;

-- Admin reopens a locked session: the remaining time at the moment it locked is given back
-- (at least 60 s), and the next leave locks again. The reason is recorded as a signal.
create or replace function public.admin_reopen_session(p_kind text, p_id uuid, p_reason text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked timestamptz;
  deadline timestamptz;
  owner uuid;
  new_deadline timestamptz;
begin
  if not public.is_admin() then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 20 then
    raise exception 'reason_too_short' using errcode = 'P0001';
  end if;
  if p_kind = 'reasoning' then
    select locked_at, deadline_at, user_id into locked, deadline, owner from public.reasoning_attempts where id = p_id for update;
  elsif p_kind = 'quiz' then
    select locked_at, deadline_at, user_id into locked, deadline, owner from public.quiz_attempts where id = p_id for update;
  elsif p_kind = 'interview' then
    select locked_at, deadline_at, user_id into locked, deadline, owner from public.interview_sessions where id = p_id for update;
  else
    raise exception 'invalid_kind' using errcode = 'P0001';
  end if;
  if owner is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if locked is null then
    raise exception 'not_locked' using errcode = 'P0001';
  end if;

  new_deadline := now() + greatest(deadline - locked, interval '60 seconds');
  perform set_config('chase.reopen', 'on', true);
  if p_kind = 'reasoning' then
    update public.reasoning_attempts set deadline_at = new_deadline, locked_at = null, lock_reason = null,
      tab_leaves = 1, reopen_count = reopen_count + 1 where id = p_id;
  elsif p_kind = 'quiz' then
    update public.quiz_attempts set deadline_at = new_deadline, locked_at = null, lock_reason = null,
      tab_leaves = 1, reopen_count = reopen_count + 1 where id = p_id;
  else
    update public.interview_sessions set deadline_at = new_deadline, locked_at = null, lock_reason = null,
      tab_leaves = 1, reopen_count = reopen_count + 1 where id = p_id;
  end if;
  perform set_config('chase.reopen', 'off', true);

  insert into public.signals (user_id, context, kind, payload)
  values (owner, p_kind, 'session_reopened',
          jsonb_build_object('id', p_id, 'by', auth.uid(), 'reason', left(btrim(p_reason), 500), 'new_deadline', new_deadline));
  return new_deadline;
end;
$$;
revoke execute on function public.admin_reopen_session(text, uuid, text) from public, anon;
grant execute on function public.admin_reopen_session(text, uuid, text) to authenticated;

-- Accessibility accommodation for the spoken interview. Only before the interview starts.
create or replace function public.admin_set_interview_mode(p_application_id uuid, p_mode text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  if p_mode not in ('voice', 'typed') then
    raise exception 'invalid_mode' using errcode = 'P0001';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 20 then
    raise exception 'reason_too_short' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.interview_sessions s where s.application_id = p_application_id) then
    raise exception 'interview_already_started' using errcode = 'P0001';
  end if;
  update public.applications
  set interview_answer_mode = p_mode, interview_mode_reason = btrim(p_reason), interview_mode_set_by = auth.uid()
  where id = p_application_id;
  if not found then
    raise exception 'application_not_found' using errcode = 'P0002';
  end if;
end;
$$;
revoke execute on function public.admin_set_interview_mode(uuid, text, text) from public, anon;
grant execute on function public.admin_set_interview_mode(uuid, text, text) to authenticated;

-- ───────────────────────── Audio storage ─────────────────────────
-- Spoken answers are uploaded by the server (service role) to interview-audio/{user_id}/...
-- and kept with the rest of the candidate's data until the retention purge.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('interview-audio', 'interview-audio', false, 10485760,
        array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-m4a', 'audio/aac'])
on conflict (id) do nothing;
create policy interview_audio_admin_read on storage.objects
  for select to authenticated
  using (bucket_id = 'interview-audio' and public.is_admin());

-- ───────────────────────── Interview rubric v2 (spoken answers) ─────────────────────────
insert into public.rubrics (key, version, title, criteria)
select 'interview', 2, 'AI CV-verification interview (spoken, adaptive)',
  (select jsonb_agg(
     case when c->>'key' = 'communication' then
       c || jsonb_build_object(
         'description', 'Structure and clarity of the spoken answers, read from an automatic transcript. Judge structure only: ignore filler words, hesitations, accent, second-language English and transcription errors.',
         'anchors', jsonb_build_object('1', 'No structure: the point is hard to find', '3', 'Understandable, the point emerges eventually', '5', 'Answer-first, concise, structured'))
     else c end order by ord)
   from jsonb_array_elements((select criteria from public.rubrics where key = 'interview' and version = 1)) with ordinality as t(c, ord))
on conflict (key, version) do nothing;
update public.rubrics set active = false where key = 'interview' and version = 1;
