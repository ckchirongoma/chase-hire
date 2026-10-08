-- Roles, applications, admin decisions and review requests.
-- Hard rule: nothing auto-rejects. Only admin_decide() can move an application to
-- advanced/rejected, and only with a written reason (>= 20 chars) recorded in decisions.

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]+$'),
  title text not null,
  summary text not null,
  spec_md text not null default '',
  salary_min int not null check (salary_min > 0),       -- rands per month, gross
  salary_max int not null check (salary_max >= salary_min),
  location_note text not null default '',
  reasoning_min_stars int not null default 3 check (reasoning_min_stars between 1 and 6),
  quiz_flag_pct int not null default 50 check (quiz_flag_pct between 0 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.roles enable row level security;
create trigger roles_updated_at before update on public.roles
  for each row execute function public.set_updated_at();

create policy roles_public_select on public.roles
  for select to anon, authenticated using (active);
create policy roles_admin_select on public.roles
  for select to authenticated using (public.is_admin());
create policy roles_admin_insert on public.roles
  for insert to authenticated with check (public.is_admin());
create policy roles_admin_update on public.roles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
grant select on public.roles to anon, authenticated;
grant insert, update on public.roles to authenticated;

insert into public.roles (slug, title, summary, spec_md, salary_min, salary_max, location_note, reasoning_min_stars, quiz_flag_pct)
values
('business-analyst', 'AI-native Business Analyst',
 'Find what the client hasn''t noticed, take a position on what will move the numbers, and build the first working version.',
 'Run discovery with operations teams and executives; dig into messy spreadsheets and system exports to find what''s missing; research and form a clear point of view; prototype with AI tools; hand developers a spec they can build from without asking questions.',
 30000, 32500, 'Remote within South Africa.', 3, 50),
('software-engineer', 'AI-native Software Engineer',
 'Take working prototypes and make them production-grade: secure, tested, deployed and run.',
 'Harden prototypes (RLS, migrations, secrets, CI, monitoring); build data pipelines that survive messy client exports; deploy into our and clients'' clouds; design and cost systems before we sell them; explain all of it clearly to client executives.',
 30000, 32500, 'Remote within South Africa (Cape Town or Johannesburg preferred for occasional in-person client sessions).', 3, 55);

create table public.applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  role_id uuid not null references public.roles (id),
  stage text not null default 'interview' check (stage in
    ('interview', 'quiz', 'work_1', 'work_2', 'grading', 'shortlist', 'live', 'offer', 'closed')),
  status text not null default 'in_progress' check (status in
    ('in_progress', 'submitted', 'awaiting_review', 'advanced', 'rejected', 'withdrawn', 'lapsed')),
  below_hurdle boolean not null default false,
  reasoning_stars int,
  composite_score numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, role_id)
);
alter table public.applications enable row level security;
create trigger applications_updated_at before update on public.applications
  for each row execute function public.set_updated_at();

create policy applications_owner_select on public.applications
  for select to authenticated using (user_id = auth.uid());
create policy applications_admin_select on public.applications
  for select to authenticated using (public.is_admin());
grant select on public.applications to authenticated;
-- No client writes: candidates apply via apply_to_role(), admins decide via admin_decide().

create table public.decisions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,
  stage text not null,
  decision text not null check (decision in ('advance', 'reject', 'hold')),
  reason text not null check (length(btrim(reason)) >= 20),
  scores_snapshot jsonb not null default '{}',
  decided_by uuid not null references auth.users (id),
  decided_at timestamptz not null default now()
);
alter table public.decisions enable row level security;
create index decisions_application_idx on public.decisions (application_id, decided_at desc);

create policy decisions_admin_select on public.decisions
  for select to authenticated using (public.is_admin());
create policy decisions_owner_select on public.decisions
  for select to authenticated using (
    exists (select 1 from public.applications a where a.id = application_id and a.user_id = auth.uid())
  );
grant select on public.decisions to authenticated;

-- Belt and braces: even a service-role code path cannot set advanced/rejected
-- unless a matching decision row was written in the same transaction.
create or replace function public.applications_status_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status in ('advanced', 'rejected')
     and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    if tg_op = 'INSERT' or not exists (
      select 1 from public.decisions d
      where d.application_id = new.id
        and d.decided_at = now()
        and d.decision = case new.status when 'advanced' then 'advance' else 'reject' end
    ) then
      raise exception 'status_change_requires_admin_decision' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger applications_status_guard
  before insert or update on public.applications
  for each row execute function public.applications_status_guard();

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

  -- The scores visible at decision time.
  select jsonb_build_object(
    'application', jsonb_build_object(
      'stage', app.stage, 'status', app.status, 'below_hurdle', app.below_hurdle,
      'reasoning_stars', app.reasoning_stars, 'composite_score', app.composite_score),
    'reasoning', (
      select jsonb_build_object('raw_score', r.raw_score, 'percentile', r.percentile,
                                'stars', r.stars, 'norm_version', r.norm_version)
      from public.reasoning_attempts r
      where r.user_id = app.user_id and r.submitted_at is not null
      order by r.started_at desc limit 1)
  ) into snapshot;

  insert into public.decisions (application_id, stage, decision, reason, scores_snapshot, decided_by)
  values (app.id, app.stage, p_decision, btrim(p_reason), snapshot, auth.uid())
  returning id into decision_id;

  update public.applications
  set status = case p_decision when 'advance' then 'advanced'
                               when 'reject' then 'rejected'
                               else 'awaiting_review' end
  where id = app.id;

  return decision_id;
end;
$$;
grant execute on function public.admin_decide(uuid, text, text) to authenticated;

-- Candidate applies to a role. Never rejects: a below-hurdle candidate is queued
-- for admin review (status awaiting_review) instead.
create or replace function public.apply_to_role(p_slug text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  r public.roles%rowtype;
  latest_stars int;
  app_id uuid;
begin
  if uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select * into r from public.roles where slug = p_slug and active;
  if not found then
    raise exception 'role_not_found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.consents where user_id = uid) then
    raise exception 'consent_required' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.cvs where user_id = uid and status = 'parsed') then
    raise exception 'cv_required' using errcode = 'P0001';
  end if;
  select stars into latest_stars from public.reasoning_attempts
  where user_id = uid and form = 'online' and submitted_at is not null
  order by started_at desc limit 1;
  if latest_stars is null then
    raise exception 'reasoning_required' using errcode = 'P0001';
  end if;

  select id into app_id from public.applications where user_id = uid and role_id = r.id;
  if app_id is not null then
    return app_id;
  end if;

  insert into public.applications (user_id, role_id, stage, status, below_hurdle, reasoning_stars)
  values (uid, r.id, 'interview',
          case when latest_stars < r.reasoning_min_stars then 'awaiting_review' else 'in_progress' end,
          latest_stars < r.reasoning_min_stars, latest_stars)
  returning id into app_id;
  return app_id;
end;
$$;
grant execute on function public.apply_to_role(text) to authenticated;

-- POPIA s71: the right to make representations about any score.
create table public.review_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  application_id uuid references public.applications (id) on delete cascade,
  stage text not null check (stage in ('reasoning', 'cv', 'interview', 'quiz', 'work_1', 'work_2', 'live', 'decision')),
  message text not null check (length(btrim(message)) between 10 and 4000),
  status text not null default 'open' check (status in ('open', 'responded', 'closed')),
  response text,
  responded_by uuid references auth.users (id),
  responded_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.review_requests enable row level security;
create index review_requests_status_idx on public.review_requests (status, created_at);

create policy review_requests_owner_insert on public.review_requests
  for insert to authenticated with check (
    user_id = auth.uid()
    and (application_id is null or exists (
      select 1 from public.applications a where a.id = application_id and a.user_id = auth.uid()))
  );
create policy review_requests_owner_select on public.review_requests
  for select to authenticated using (user_id = auth.uid());
create policy review_requests_admin_select on public.review_requests
  for select to authenticated using (public.is_admin());
create policy review_requests_admin_update on public.review_requests
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
grant select on public.review_requests to authenticated;
grant insert (application_id, stage, message) on public.review_requests to authenticated;
grant update (status, response, responded_by, responded_at) on public.review_requests to authenticated;
