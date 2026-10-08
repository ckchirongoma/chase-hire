-- Integrity signals (logged, never decisive on their own) and the admin candidate view.

create table public.signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  context text not null check (length(context) <= 100),
  kind text not null check (kind in
    ('paste_attempt', 'copy_attempt', 'blur', 'focus', 'burst_input', 'answer_time', 'live_delta', 'prompt_injection')),
  payload jsonb not null default '{}' check (octet_length(payload::text) <= 2000),
  created_at timestamptz not null default now()
);
alter table public.signals enable row level security;
create index signals_user_idx on public.signals (user_id, created_at desc);

-- Candidates' browsers may log client-side signals about themselves only.
-- answer_time / prompt_injection / live_delta are written server-side.
create policy signals_owner_insert on public.signals
  for insert to authenticated with check (
    user_id = auth.uid() and kind in ('paste_attempt', 'copy_attempt', 'blur', 'focus', 'burst_input')
  );
create policy signals_admin_select on public.signals
  for select to authenticated using (public.is_admin());
grant select on public.signals to authenticated;
grant insert (context, kind, payload) on public.signals to authenticated;

-- One row per person for the admin candidate table. security_invoker: RLS on the
-- underlying tables applies, so a non-admin only ever sees their own row.
create view public.admin_candidates with (security_invoker = true) as
select
  p.user_id,
  p.email,
  p.full_name,
  p.phone_e164,
  p.city,
  p.province,
  p.created_at as signed_up_at,
  (select max(c.accepted_at) from public.consents c where c.user_id = p.user_id) as consented_at,
  cv.id as cv_id,
  cv.status as cv_status,
  cv.created_at as cv_uploaded_at,
  cv.injection_flags as cv_injection_flags,
  ra.raw_score,
  ra.percentile,
  ra.stars,
  ra.norm_version,
  ra.submitted_at as reasoning_submitted_at,
  (select count(*) from public.dedupe_flags d
     where (d.user_id = p.user_id or d.matched_user_id = p.user_id) and d.status = 'open') as open_dedupe_flags,
  (select count(*) from public.signals s where s.user_id = p.user_id) as signal_count,
  (select count(*) from public.review_requests rr where rr.user_id = p.user_id and rr.status = 'open') as open_review_requests,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'role', r.slug, 'stage', a.stage, 'status', a.status, 'below_hurdle', a.below_hurdle)
      order by a.created_at)
    from public.applications a join public.roles r on r.id = a.role_id
    where a.user_id = p.user_id), '[]'::jsonb) as applications,
  exists (select 1 from public.admins ad where ad.user_id = p.user_id) as is_admin
from public.profiles p
left join lateral (
  select c.id, c.status, c.created_at, c.injection_flags
  from public.cvs c where c.user_id = p.user_id
  order by c.created_at desc limit 1
) cv on true
left join lateral (
  select a.raw_score, a.percentile, a.stars, a.norm_version, a.submitted_at
  from public.reasoning_attempts a
  where a.user_id = p.user_id and a.form = 'online' and a.submitted_at is not null
  order by a.started_at desc limit 1
) ra on true;

grant select on public.admin_candidates to authenticated;
