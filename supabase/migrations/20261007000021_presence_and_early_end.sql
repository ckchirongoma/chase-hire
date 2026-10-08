-- Tab rule, part 2: closing the tab, reloading, or navigating away from a timed stage counts as
-- leaving it. The page reports "away" as it goes (a beacon on pagehide / hidden / unmount) and
-- "back" whenever the stage page is shown again. The server measures the time away from its
-- own clock, so a page that never comes back still leaves a timestamp, and a candidate who
-- closes the tab and reopens the stage later gets the same pause (first time) or lock (second)
-- as one who switched tabs. Still never a rejection: an admin reopens a lock with the time left.
--
-- Also: a candidate may end the AI interview early (end_reason 'ended_by_candidate').

alter table public.reasoning_attempts add column if not exists away_since timestamptz;
alter table public.quiz_attempts add column if not exists away_since timestamptz;
alter table public.interview_sessions add column if not exists away_since timestamptz;

alter table public.interview_sessions drop constraint if exists interview_sessions_end_reason_check;
alter table public.interview_sessions add constraint interview_sessions_end_reason_check
  check (end_reason in ('completed', 'timeout', 'ended_by_candidate'));

alter table public.signals drop constraint if exists signals_kind_check;
alter table public.signals add constraint signals_kind_check check (kind in (
  'paste_attempt', 'copy_attempt', 'blur', 'focus', 'burst_input', 'answer_time', 'live_delta',
  'prompt_injection', 'tab_pause', 'session_locked', 'session_reopened', 'page_closed'));

-- The page is going away (hidden, closed, reloaded or navigated off). Starts the away clock if
-- the stage is still running; a close is also logged as a signal.
create or replace function public.mark_away(p_kind text, p_id uuid, p_user uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  if p_kind = 'reasoning' then
    update public.reasoning_attempts set away_since = coalesce(away_since, now())
    where id = p_id and user_id = p_user and submitted_at is null and locked_at is null and now() <= deadline_at;
  elsif p_kind = 'quiz' then
    update public.quiz_attempts set away_since = coalesce(away_since, now())
    where id = p_id and user_id = p_user and submitted_at is null and locked_at is null and now() <= deadline_at;
  elsif p_kind = 'interview' then
    update public.interview_sessions set away_since = coalesce(away_since, now())
    where id = p_id and user_id = p_user and ended_at is null and locked_at is null and now() <= deadline_at;
  else
    raise exception 'invalid_kind' using errcode = 'P0001';
  end if;
  get diagnostics n = row_count;
  if n > 0 and p_reason = 'closed' then
    insert into public.signals (user_id, context, kind, payload)
    values (p_user, p_kind, 'page_closed', jsonb_build_object('id', p_id));
  end if;
end;
$$;

-- The stage page is showing again. Time away (by the DB clock) goes through record_tab_leave:
-- under 2 seconds is ignored, otherwise the first leave pauses and the second locks. When the
-- same page was only hidden, it also reports how long (p_client_ms); the shorter of the two
-- (plus 5 s of slack) is used, so an "away" beacon that arrives late can't inflate a short hide.
create or replace function public.mark_back(p_kind text, p_id uuid, p_user uuid, p_client_ms int default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  since timestamptz;
  owner uuid;
begin
  if p_kind = 'reasoning' then
    select user_id, away_since into owner, since from public.reasoning_attempts where id = p_id for update;
    update public.reasoning_attempts set away_since = null where id = p_id and away_since is not null;
  elsif p_kind = 'quiz' then
    select user_id, away_since into owner, since from public.quiz_attempts where id = p_id for update;
    update public.quiz_attempts set away_since = null where id = p_id and away_since is not null;
  elsif p_kind = 'interview' then
    select user_id, away_since into owner, since from public.interview_sessions where id = p_id for update;
    update public.interview_sessions set away_since = null where id = p_id and away_since is not null;
  else
    raise exception 'invalid_kind' using errcode = 'P0001';
  end if;
  if owner is null or owner <> p_user then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if since is null then
    return 'ignored';
  end if;
  return public.record_tab_leave(p_kind, p_id, p_user,
    least(extract(epoch from now() - since) * 1000, coalesce(p_client_ms::numeric + 5000, 86400000), 86400000)::int);
end;
$$;

revoke execute on function public.mark_away(text, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.mark_back(text, uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.mark_away(text, uuid, uuid, text) to service_role;
grant execute on function public.mark_back(text, uuid, uuid, int) to service_role;
