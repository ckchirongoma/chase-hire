-- Wave 4: live-stage scorecards, batch advance, composite scores, calibration, retention
-- purge, optional demographics for adverse-impact monitoring, item statistics.

-- ───────────────────────── Live stage ─────────────────────────
-- Anchored question bank for the structured panel interview and the other live scorecards.
create table public.live_questions (
  id uuid primary key default gen_random_uuid(),
  role_slug text not null references public.roles (slug) on update cascade,
  kind text not null check (kind in ('panel_interview', 'live_defence', 'live_elicitation', 'exec_scenario')),
  key text not null,
  position int not null,
  text text not null,
  probes text[] not null default '{}',
  anchors jsonb not null,               -- {"1": "...", "3": "...", "5": "..."}
  active boolean not null default true,
  unique (role_slug, kind, key)
);
alter table public.live_questions enable row level security;
create policy live_questions_admin_select on public.live_questions for select to authenticated using (public.is_admin());
create policy live_questions_admin_update on public.live_questions for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy live_questions_admin_insert on public.live_questions for insert to authenticated with check (public.is_admin());
grant select, insert on public.live_questions to authenticated;
grant update (text, probes, anchors, position, active) on public.live_questions to authenticated;

create table public.live_scorecards (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,
  kind text not null check (kind in
    ('panel_interview', 'live_defence', 'live_elicitation', 'exec_scenario', 'reasoning_retest', 'portfolio')),
  rater uuid not null default auth.uid() references auth.users (id),
  scores jsonb not null default '{}',    -- {question_key: 1..5}; reasoning_retest: {"raw": 0..12}
  total numeric check (total between 0 and 100),
  notes text,
  submitted_at timestamptz,              -- null = draft; once submitted it is final
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (application_id, kind, rater)
);
alter table public.live_scorecards enable row level security;
create trigger live_scorecards_updated_at before update on public.live_scorecards
  for each row execute function public.set_updated_at();

-- Raters score independently: you see other raters' scorecards for an application and kind
-- only after submitting your own (security definer avoids recursive RLS).
create or replace function public.has_submitted_scorecard(p_application_id uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.live_scorecards s
    where s.application_id = p_application_id and s.kind = p_kind
      and s.rater = auth.uid() and s.submitted_at is not null);
$$;
revoke execute on function public.has_submitted_scorecard(uuid, text) from public, anon;
grant execute on function public.has_submitted_scorecard(uuid, text) to authenticated;

create policy live_scorecards_select on public.live_scorecards for select to authenticated using (
  public.is_admin() and (rater = auth.uid() or public.has_submitted_scorecard(application_id, kind)));
create policy live_scorecards_insert on public.live_scorecards for insert to authenticated
  with check (public.is_admin() and rater = auth.uid());
create policy live_scorecards_update on public.live_scorecards for update to authenticated
  using (public.is_admin() and rater = auth.uid()) with check (public.is_admin() and rater = auth.uid());
grant select on public.live_scorecards to authenticated;
grant insert (application_id, kind, scores, total, notes, submitted_at) on public.live_scorecards to authenticated;
grant update (scores, total, notes, submitted_at) on public.live_scorecards to authenticated;

create or replace function public.live_scorecard_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.submitted_at is not null then
    raise exception 'scorecard_already_submitted' using errcode = 'P0001';
  end if;
  if new.submitted_at is not null then
    new.submitted_at := now();
  end if;
  return new;
end;
$$;
create trigger live_scorecards_guard before insert or update on public.live_scorecards
  for each row execute function public.live_scorecard_guard();

-- Final composite (pre-live 50% + live 50%) lives next to the pre-live composite.
alter table public.applications add column if not exists final_score numeric check (final_score between 0 and 100);
alter table public.applications add column if not exists live_delta numeric;

-- ───────────────────────── Batch advance ─────────────────────────
-- Only after an admin explicitly confirms "Advance N candidates". One reason is recorded on
-- every decision. Rejections are never batched.
create or replace function public.admin_batch_advance(p_application_ids uuid[], p_reason text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  app_id uuid;
  n int := 0;
begin
  if not public.is_admin() then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  if cardinality(p_application_ids) = 0 or cardinality(p_application_ids) > 200 then
    raise exception 'batch_size_invalid' using errcode = 'P0001';
  end if;
  foreach app_id in array p_application_ids loop
    perform public.admin_decide(app_id, 'advance', p_reason);
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.admin_batch_advance(uuid[], text) from public, anon;
grant execute on function public.admin_batch_advance(uuid[], text) to authenticated;

-- ───────────────────────── Calibration (docs/09 §8) ─────────────────────────
create table public.gold_samples (
  id uuid primary key default gen_random_uuid(),
  rubric_key text not null,
  label text not null,                   -- e.g. "weak", "strong", "doc 13 reference"
  file_path text,                        -- gold bucket
  text_content text not null,            -- the submission text the graders see
  human_scores jsonb not null default '{}', -- {criterion_key: [rater1, rater2]} on the 1-5 scale
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
alter table public.gold_samples enable row level security;
create policy gold_admin_all on public.gold_samples for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.gold_samples to authenticated;

create table public.calibration_runs (
  id uuid primary key default gen_random_uuid(),
  rubric_key text not null,
  rubric_version int not null,
  model text not null,
  prompt_versions text[] not null default '{}',
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  per_criterion jsonb not null default '{}', -- {criterion_key: {icc, qwk, n, human_icc, status: 'live'|'review'|'human_only'}}
  passed boolean,
  error text,
  ran_by uuid references auth.users (id),
  ran_at timestamptz not null default now(),
  finished_at timestamptz
);
alter table public.calibration_runs enable row level security;
create policy calibration_admin_select on public.calibration_runs for select to authenticated using (public.is_admin());
grant select on public.calibration_runs to authenticated;

-- ───────────────────────── Optional demographics (separate consent) ─────────────────────────
-- Collected only with separate, voluntary consent; stored apart from assessment data;
-- never shown to graders or raters. Admins see aggregates only (adverse_impact_report()).
create table public.demographics (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  consented_at timestamptz not null default now(),
  population_group text check (population_group in ('african', 'coloured', 'indian', 'white', 'other', 'prefer_not')),
  gender text check (gender in ('female', 'male', 'non_binary', 'prefer_not')),
  disability text check (disability in ('yes', 'no', 'prefer_not')),
  updated_at timestamptz not null default now()
);
alter table public.demographics enable row level security;
create trigger demographics_updated_at before update on public.demographics
  for each row execute function public.set_updated_at();
create policy demographics_owner_select on public.demographics for select to authenticated using (user_id = auth.uid());
create policy demographics_owner_insert on public.demographics for insert to authenticated with check (user_id = auth.uid());
create policy demographics_owner_update on public.demographics for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy demographics_owner_delete on public.demographics for delete to authenticated using (user_id = auth.uid());
grant select, insert, update, delete on public.demographics to authenticated;

-- Pass/advance rates by group for one stage; groups under p_min_n are suppressed.
create or replace function public.adverse_impact_report(p_stage text, p_dimension text, p_min_n int default 30)
returns table (grp text, candidates bigint, advanced bigint, rate numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  if p_dimension not in ('population_group', 'gender', 'disability') then
    raise exception 'invalid_dimension' using errcode = 'P0001';
  end if;
  return query execute format($f$
    with reached as (
      select distinct a.id as app_id, coalesce(d.%1$I, 'not_disclosed') as grp,
        exists (select 1 from public.decisions x where x.application_id = a.id and x.stage = $1 and x.decision = 'advance') as adv
      from public.applications a
      left join public.demographics d on d.user_id = a.user_id
      where a.stage = $1
         or exists (select 1 from public.decisions x where x.application_id = a.id and x.stage = $1)
    )
    select grp, count(*)::bigint, count(*) filter (where adv)::bigint,
           round(count(*) filter (where adv)::numeric / nullif(count(*), 0), 3)
    from reached group by grp having count(*) >= $2 order by grp
  $f$, p_dimension) using p_stage, p_min_n;
end;
$$;
revoke execute on function public.adverse_impact_report(text, text, int) from public, anon;
grant execute on function public.adverse_impact_report(text, text, int) to authenticated;

-- ───────────────────────── Retention (docs/12) ─────────────────────────
create table public.retention_queue (
  user_id uuid primary key references auth.users (id) on delete cascade,
  purge_after date not null,
  reason text not null,
  updated_at timestamptz not null default now()
);
alter table public.retention_queue enable row level security;
create policy retention_admin_select on public.retention_queue for select to authenticated using (public.is_admin());
grant select on public.retention_queue to authenticated;

create table public.purge_log (
  id uuid primary key default gen_random_uuid(),
  user_id_hash text not null,
  purged_at timestamptz not null default now(),
  scope text not null,
  detail jsonb not null default '{}'
);
alter table public.purge_log enable row level security;
create policy purge_log_admin_select on public.purge_log for select to authenticated using (public.is_admin());
grant select on public.purge_log to authenticated;

-- Minimal decision log kept after a purge (keyed by a hashed id) for disputes.
create table public.decision_archive (
  id uuid primary key default gen_random_uuid(),
  user_id_hash text not null,
  role_slug text,
  stage text,
  decision text,
  reason text,
  decided_at timestamptz,
  archived_at timestamptz not null default now()
);
alter table public.decision_archive enable row level security;
create policy decision_archive_admin_select on public.decision_archive for select to authenticated using (public.is_admin());
grant select on public.decision_archive to authenticated;

-- Anonymised item-level statistics kept for validity/fairness work after a purge.
create table public.item_response_archive (
  id bigint generated always as identity primary key,
  source text not null check (source in ('reasoning', 'quiz')),
  item_id uuid,
  family_or_topic text,
  tier text,
  correct boolean,
  seconds numeric,
  archived_at timestamptz not null default now()
);
alter table public.item_response_archive enable row level security;
create policy item_archive_admin_select on public.item_response_archive for select to authenticated using (public.is_admin());
grant select on public.item_response_archive to authenticated;

-- Recompute who is due for purging. Unsuccessful/inactive candidates: 6 months after their
-- last activity (round close); talent-pool opt-in: 12 months. Hired candidates and admins are
-- never queued. Anyone with an application still in play is removed from the queue.
create or replace function public.refresh_retention_queue()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  delete from public.retention_queue q
  where exists (select 1 from public.admins ad where ad.user_id = q.user_id)
     or exists (
       select 1 from public.applications a
       where a.user_id = q.user_id
         and (a.status not in ('rejected', 'withdrawn', 'lapsed')
              and not (a.stage = 'closed')));

  with people as (
    select u.id as user_id,
      greatest(
        u.created_at,
        coalesce((select max(a.updated_at) from public.applications a where a.user_id = u.id), u.created_at),
        coalesce((select max(d.decided_at) from public.decisions d join public.applications a on a.id = d.application_id where a.user_id = u.id), u.created_at),
        coalesce((select max(r.started_at) from public.reasoning_attempts r where r.user_id = u.id), u.created_at),
        coalesce((select max(c.created_at) from public.cvs c where c.user_id = u.id), u.created_at)
      ) as last_activity,
      coalesce((select c.talent_pool_opt_in from public.consents c where c.user_id = u.id order by c.accepted_at desc limit 1), false) as pool
    from auth.users u
    where not exists (select 1 from public.admins ad where ad.user_id = u.id)
      and not exists (
        select 1 from public.applications a where a.user_id = u.id
          and a.status not in ('rejected', 'withdrawn', 'lapsed') and a.stage <> 'closed')
      -- hired: an application closed after an advance from the offer stage
      and not exists (
        select 1 from public.applications a where a.user_id = u.id and a.stage = 'closed' and a.status = 'advanced')
  )
  insert into public.retention_queue (user_id, purge_after, reason, updated_at)
  select user_id,
         (last_activity + case when pool then interval '12 months' else interval '6 months' end)::date,
         case when pool then 'talent pool (12 months)' else 'inactive or unsuccessful (6 months)' end,
         now()
  from people
  on conflict (user_id) do update
    set purge_after = excluded.purge_after, reason = excluded.reason, updated_at = now();
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.refresh_retention_queue() from public, anon, authenticated;
grant execute on function public.refresh_retention_queue() to service_role;

-- ───────────────────────── Reasoning item statistics ─────────────────────────
-- Per template (family x tier): exposures, proportion correct and point-biserial against the
-- attempt's raw score. Stats count only after 40 exposures (docs/04 §4).
create or replace function public.refresh_reasoning_item_stats()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  with resp as (
    select r.item_id, case when r.correct then 1.0 else 0.0 end as x, a.raw_score::numeric as total
    from public.reasoning_responses r
    join public.reasoning_attempts a on a.id = r.attempt_id
    where a.submitted_at is not null and r.served_at is not null
  ), agg as (
    select item_id, count(*) as n, avg(x) as p, corr(x, total) as pb
    from resp group by item_id
  )
  update public.reasoning_items i
  set exposures = agg.n,
      difficulty_p = case when agg.n >= 40 then round(agg.p, 3) else null end,
      discrimination = case when agg.n >= 40 then round(agg.pb::numeric, 3) else null end
  from agg where agg.item_id = i.id;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.refresh_reasoning_item_stats() from public, anon, authenticated;
grant execute on function public.refresh_reasoning_item_stats() to service_role;

revoke execute on function public.live_scorecard_guard() from public, anon, authenticated;
