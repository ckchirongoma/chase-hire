-- Per-user rate limits for paid API calls (the AI summary). Counted in the database so the limit
-- holds across serverless instances. Fixed windows: simple, and good enough for a cost cap.

create table public.api_rate_limits (
  user_id uuid not null,
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (user_id, bucket, window_start)
);
alter table public.api_rate_limits enable row level security;
-- No policies: only take_rate_limit() touches this table.
revoke all on public.api_rate_limits from anon, authenticated;

create or replace function public.take_rate_limit(p_bucket text, p_limit integer, p_window_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_window timestamptz;
  v_count integer;
begin
  if v_user is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if p_limit < 1 or p_window_seconds < 1 then
    raise exception 'invalid rate limit' using errcode = '22023';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.api_rate_limits as r (user_id, bucket, window_start, count)
  values (v_user, p_bucket, v_window, 1)
  on conflict (user_id, bucket, window_start) do update set count = r.count + 1
  returning r.count into v_count;

  -- Housekeeping: forget old windows for this user.
  delete from public.api_rate_limits
   where user_id = v_user and window_start < now() - interval '2 days';

  return jsonb_build_object(
    'allowed', v_count <= p_limit,
    'count', v_count,
    'limit', p_limit,
    'reset_at', v_window + make_interval(secs => p_window_seconds)
  );
end;
$$;
revoke execute on function public.take_rate_limit(text, integer, integer) from public, anon;
grant execute on function public.take_rate_limit(text, integer, integer) to authenticated, service_role;
