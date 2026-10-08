-- Wave 4: retention purge, compliance reporting and item statistics (docs/12, docs/09 §9, docs/04 §4).
-- Re-runnable: every object is created with "if not exists" / "or replace" / drop-then-create.
--
-- Retention rules (lib/consent/notice.ts, docs/12 §1 "Retention automation"):
--   * not appointed: purged 6 months after the application closed (rejected, withdrawn, lapsed
--     or closed), or 6 months after the last activity of someone who never applied;
--   * talent-pool opt-in (the latest consents row decides): 12 months instead;
--   * never queued: admins, anyone with an application still in play, appointed candidates
--     (advanced out of the offer stage: employee records, outside this purge) and anyone with an
--     open review request (a dispute in progress needs the evidence).
-- lib/stats/retention.ts mirrors the date arithmetic for unit tests.

-- ───────────────────────── When an application closed ─────────────────────────
-- updated_at moves on every composite refresh, so it can't anchor the 6-month clock.
alter table public.applications add column if not exists closed_at timestamptz;

create or replace function public.application_closed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  now_closed boolean := new.status in ('rejected', 'withdrawn', 'lapsed') or new.stage = 'closed';
  was_closed boolean := false;
begin
  if tg_op = 'UPDATE' then
    was_closed := old.status in ('rejected', 'withdrawn', 'lapsed') or old.stage = 'closed';
  end if;
  if not now_closed then
    new.closed_at := null;          -- re-opened (e.g. an admin released a rejected application)
  elsif not was_closed then
    new.closed_at := now();
  end if;
  return new;
end;
$$;
revoke execute on function public.application_closed_at() from public, anon, authenticated;
drop trigger if exists applications_closed_at on public.applications;
create trigger applications_closed_at
  before insert or update of status, stage on public.applications
  for each row execute function public.application_closed_at();

-- Backfill: the latest decision on a closed application is when it closed (updated_at otherwise).
alter table public.applications disable trigger applications_updated_at;
update public.applications a
set closed_at = coalesce((select max(d.decided_at) from public.decisions d where d.application_id = a.id), a.updated_at)
where a.closed_at is null and (a.status in ('rejected', 'withdrawn', 'lapsed') or a.stage = 'closed');
alter table public.applications enable trigger applications_updated_at;

-- ───────────────────────── Retention schedule ─────────────────────────
alter table public.retention_queue add column if not exists basis_at timestamptz;

-- Who is due for purging and when, computed live from the rules above (read-only).
create or replace function public.retention_schedule(p_user_ids uuid[] default null)
returns table (user_id uuid, purge_after date, reason text, basis text, basis_at timestamptz, talent_pool boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with people as (
    select u.id, u.created_at
    from auth.users u
    where (p_user_ids is null or u.id = any (p_user_ids))
      and not exists (select 1 from public.admins ad where ad.user_id = u.id)
      and not exists (
        select 1 from public.applications a
        where a.user_id = u.id and a.status not in ('rejected', 'withdrawn', 'lapsed') and a.stage <> 'closed')
      and not exists (
        select 1 from public.applications a
        where a.user_id = u.id and a.stage = 'closed' and a.status = 'advanced')
      and not exists (select 1 from public.review_requests rr where rr.user_id = u.id and rr.status = 'open')
  ), facts as (
    select p.id,
      (select max(coalesce(a.closed_at,
                           (select max(d.decided_at) from public.decisions d where d.application_id = a.id),
                           a.updated_at))
         from public.applications a where a.user_id = p.id) as closed_at,
      greatest(
        p.created_at,
        (select max(c.accepted_at) from public.consents c where c.user_id = p.id),
        (select max(c.created_at) from public.cvs c where c.user_id = p.id),
        (select max(coalesce(r.submitted_at, r.started_at)) from public.reasoning_attempts r where r.user_id = p.id),
        (select max(a.created_at) from public.applications a where a.user_id = p.id),
        (select max(greatest(rr.created_at, rr.responded_at)) from public.review_requests rr where rr.user_id = p.id)
      ) as last_activity,
      coalesce((select c.talent_pool_opt_in from public.consents c where c.user_id = p.id
                order by c.accepted_at desc, c.id desc limit 1), false) as pool
    from people p
  )
  select f.id,
         ((greatest(f.closed_at, f.last_activity) at time zone 'UTC')
           + case when f.pool then interval '12 months' else interval '6 months' end)::date,
         case when f.pool then 'Talent pool: 12 months after ' else 'Not appointed: 6 months after ' end
           || case when f.closed_at is not null then 'the application closed' else 'the last activity (never applied)' end,
         case when f.closed_at is not null then 'application_closed' else 'no_application' end,
         greatest(f.closed_at, f.last_activity),
         f.pool
  from facts f;
$$;
revoke execute on function public.retention_schedule(uuid[]) from public, anon, authenticated;
grant execute on function public.retention_schedule(uuid[]) to service_role;

-- The nightly job: mirror the schedule into retention_queue (rows for people no longer
-- eligible are removed). Returns the number of queued people.
create or replace function public.refresh_retention_queue()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  -- The delete and the upsert touch disjoint rows (not in / in the schedule).
  with s as materialized (
    select x.user_id, x.purge_after, x.reason, x.basis_at from public.retention_schedule(null) x
  ), gone as (
    delete from public.retention_queue q
    where not exists (select 1 from s where s.user_id = q.user_id)
  ), upserted as (
    insert into public.retention_queue (user_id, purge_after, reason, basis_at, updated_at)
    select s.user_id, s.purge_after, s.reason, s.basis_at, now() from s
    on conflict (user_id) do update
      set purge_after = excluded.purge_after, reason = excluded.reason, basis_at = excluded.basis_at, updated_at = now()
      where (public.retention_queue.purge_after, public.retention_queue.reason, public.retention_queue.basis_at)
            is distinct from (excluded.purge_after, excluded.reason, excluded.basis_at)
  )
  select count(*) into n from s;
  return n;
end;
$$;
revoke execute on function public.refresh_retention_queue() from public, anon, authenticated;
grant execute on function public.refresh_retention_queue() to service_role;

-- ───────────────────────── Anonymised item responses (kept after a purge) ─────────────────────────
-- attempt_ref is a fresh random id per archived attempt (never the original attempt id), so
-- KR-20 and point-biserials can still be computed; nothing links back to a person.
alter table public.item_response_archive add column if not exists attempt_ref uuid;
alter table public.item_response_archive add column if not exists form text;
alter table public.item_response_archive add column if not exists position int;
alter table public.item_response_archive add column if not exists served boolean;
alter table public.item_response_archive add column if not exists attempt_score numeric;
alter table public.item_response_archive add column if not exists cohort_month date;
create index if not exists item_response_archive_item_idx on public.item_response_archive (source, item_id);

-- ───────────────────────── Purge state (resumable) ─────────────────────────
-- One row per purge in progress. Deliberately no foreign key to auth.users: the row has to
-- outlive the auth user's deletion so a crash after it can still finish (storage, purge_log).
-- Deleted when the purge completes, so no raw user id stays behind.
create table if not exists public.retention_purges (
  user_id uuid primary key,
  user_id_hash text not null check (user_id_hash ~ '^[0-9a-f]{64}$'),
  started_at timestamptz not null default now(),
  purge_after date,
  reason text,
  submission_ids uuid[] not null default '{}',
  interview_ids uuid[] not null default '{}',
  counts jsonb not null default '{}',
  storage_done_at timestamptz,
  auth_deleted_at timestamptz,
  attempts int not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);
alter table public.retention_purges enable row level security;
drop policy if exists retention_purges_admin_select on public.retention_purges;
create policy retention_purges_admin_select on public.retention_purges for select to authenticated using (public.is_admin());
grant select on public.retention_purges to authenticated;

-- What a purge would remove for each user (dry run). Read-only.
create or replace function public.retention_preview(p_user_ids uuid[])
returns table (user_id uuid, decisions bigint, reasoning_responses bigint, quiz_responses bigint, grades bigint,
               submission_ids uuid[], interview_ids uuid[])
language sql
stable
security definer
set search_path = ''
as $$
  select u.id,
    (select count(*) from public.decisions d join public.applications a on a.id = d.application_id where a.user_id = u.id),
    (select count(*) from public.reasoning_responses r join public.reasoning_attempts t on t.id = r.attempt_id
      where t.user_id = u.id and t.submitted_at is not null),
    (select count(*) from public.quiz_responses r join public.quiz_attempts t on t.id = r.attempt_id
      where t.user_id = u.id and t.submitted_at is not null),
    (select count(*) from public.grades g
      where (g.subject_type = 'submission' and g.subject_id in (select s.id from public.submissions s where s.user_id = u.id))
         or (g.subject_type = 'interview' and g.subject_id in (select s.id from public.interview_sessions s where s.user_id = u.id))),
    coalesce((select array_agg(s.id order by s.id) from public.submissions s where s.user_id = u.id), '{}'),
    coalesce((select array_agg(s.id order by s.id) from public.interview_sessions s where s.user_id = u.id), '{}')
  from auth.users u
  where u.id = any (p_user_ids);
$$;
revoke execute on function public.retention_preview(uuid[]) from public, anon, authenticated;
grant execute on function public.retention_preview(uuid[]) to service_role;

-- Step 1 of a purge, in one transaction: re-check the rules, archive the decision log (hashed
-- id) and the anonymised item responses, delete the grades (they have no foreign key and quote
-- the candidate's work), and record the subject ids for the later steps.
-- Returns {status: started|resumed|not_due|not_eligible, ...state}.
create or replace function public.retention_begin_purge(p_user_id uuid, p_hash text, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  st public.retention_purges%rowtype;
  s record;
  v_subs uuid[];
  v_sessions uuid[];
  n_dec int;
  n_rea int;
  n_quiz int;
  n_grades int;
  n_sum int;
  n_jobs int;
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_hash' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('retention:' || p_user_id::text, 0));

  select * into st from public.retention_purges where user_id = p_user_id;
  if found then
    return to_jsonb(st) || jsonb_build_object('status', 'resumed');
  end if;

  select * into s from public.retention_schedule(array[p_user_id]);
  if not found then
    return jsonb_build_object('status', 'not_eligible', 'user_id', p_user_id);
  end if;
  if s.purge_after > p_today then
    return jsonb_build_object('status', 'not_due', 'user_id', p_user_id, 'purge_after', s.purge_after);
  end if;

  insert into public.decision_archive (user_id_hash, role_slug, stage, decision, reason, decided_at)
  select p_hash, r.slug, d.stage, d.decision, d.reason, d.decided_at
  from public.decisions d
  join public.applications a on a.id = d.application_id
  left join public.roles r on r.id = a.role_id
  where a.user_id = p_user_id;
  get diagnostics n_dec = row_count;

  -- Submitted attempts only; unanswered items count as wrong (docs/04 §2). archived_at is
  -- truncated to the day so it can't be matched to one purge_log row.
  with att as materialized (
    select t.id, gen_random_uuid() as ref, t.form, t.raw_score, date_trunc('month', t.started_at)::date as cohort
    from public.reasoning_attempts t
    where t.user_id = p_user_id and t.submitted_at is not null
  )
  insert into public.item_response_archive
    (source, item_id, family_or_topic, tier, correct, seconds, attempt_ref, form, position, served, attempt_score, cohort_month, archived_at)
  select 'reasoning', r.item_id, r.family, r.tier, coalesce(r.correct, false),
         case when r.answered_at is not null and r.served_at is not null
              then round(extract(epoch from r.answered_at - r.served_at)::numeric, 1) end,
         att.ref, att.form, r.position, r.served_at is not null, att.raw_score, att.cohort, date_trunc('day', now())
  from public.reasoning_responses r join att on att.id = r.attempt_id;
  get diagnostics n_rea = row_count;

  with att as materialized (
    select t.id, gen_random_uuid() as ref, t.raw_score, date_trunc('month', t.started_at)::date as cohort
    from public.quiz_attempts t
    where t.user_id = p_user_id and t.submitted_at is not null
  )
  insert into public.item_response_archive
    (source, item_id, family_or_topic, tier, correct, seconds, attempt_ref, form, position, served, attempt_score, cohort_month, archived_at)
  select 'quiz', r.item_id, r.topic, null, coalesce(r.correct, false),
         case when r.answered_at is not null and r.served_at is not null
              then round(extract(epoch from r.answered_at - r.served_at)::numeric, 1) end,
         att.ref, null, r.position, r.served_at is not null, att.raw_score, att.cohort, date_trunc('day', now())
  from public.quiz_responses r join att on att.id = r.attempt_id;
  get diagnostics n_quiz = row_count;

  select coalesce(array_agg(x.id), '{}') into v_subs from public.submissions x where x.user_id = p_user_id;
  select coalesce(array_agg(x.id), '{}') into v_sessions from public.interview_sessions x where x.user_id = p_user_id;

  delete from public.grades g
  where (g.subject_type = 'submission' and g.subject_id = any (v_subs))
     or (g.subject_type = 'interview' and g.subject_id = any (v_sessions));
  get diagnostics n_grades = row_count;
  delete from public.grade_summaries g
  where (g.subject_type = 'submission' and g.subject_id = any (v_subs))
     or (g.subject_type = 'interview' and g.subject_id = any (v_sessions));
  get diagnostics n_sum = row_count;
  delete from public.grading_jobs g
  where (g.subject_type = 'submission' and g.subject_id = any (v_subs))
     or (g.subject_type = 'interview' and g.subject_id = any (v_sessions));
  get diagnostics n_jobs = row_count;

  insert into public.retention_purges (user_id, user_id_hash, purge_after, reason, submission_ids, interview_ids, counts)
  values (p_user_id, p_hash, s.purge_after, s.reason, v_subs, v_sessions, jsonb_build_object(
    'decisions_archived', n_dec,
    'reasoning_responses_archived', n_rea,
    'quiz_responses_archived', n_quiz,
    'grades_deleted', n_grades,
    'grade_summaries_deleted', n_sum,
    'grading_jobs_deleted', n_jobs))
  returning * into st;
  return to_jsonb(st) || jsonb_build_object('status', 'started');
end;
$$;
revoke execute on function public.retention_begin_purge(uuid, text, date) from public, anon, authenticated;
grant execute on function public.retention_begin_purge(uuid, text, date) to service_role;

-- Progress notes from the server (storage cleared, auth user deleted, an error to retry).
create or replace function public.retention_note_progress(p_user_id uuid, p_step text, p_counts jsonb default '{}', p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_step not in ('storage', 'auth', 'error') then
    raise exception 'invalid_step' using errcode = 'P0001';
  end if;
  update public.retention_purges
  set counts = counts || coalesce(p_counts, '{}'),
      storage_done_at = case when p_step = 'storage' then coalesce(storage_done_at, now()) else storage_done_at end,
      auth_deleted_at = case when p_step = 'auth' then coalesce(auth_deleted_at, now()) else auth_deleted_at end,
      attempts = attempts + case when p_step = 'error' then 1 else 0 end,
      last_error = case when p_step = 'error' then left(p_error, 1000) else last_error end,
      updated_at = now()
  where user_id = p_user_id;
end;
$$;
revoke execute on function public.retention_note_progress(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.retention_note_progress(uuid, text, jsonb, text) to service_role;

-- Last step, after the storage objects and the auth user are gone: check nothing keyed by the
-- user survived (any uuid column in public, any storage object), clear the auth audit log
-- entries that name them, write purge_log and drop the state row. Raises (so the purge stays
-- in progress, visible on /admin/compliance) if anything is left. Returns the purge_log id.
create or replace function public.retention_finish_purge(p_user_id uuid, p_detail jsonb default '{}')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  st public.retention_purges%rowtype;
  col record;
  hit boolean;
  prefixes text[];
  log_id uuid;
  audit_rows int := 0;
  audit_note text := null;
begin
  perform pg_advisory_xact_lock(hashtextextended('retention:' || p_user_id::text, 0));
  select * into st from public.retention_purges where user_id = p_user_id for update;
  if not found then
    return null;  -- already finished
  end if;
  if exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'purge_auth_user_still_exists' using errcode = 'P0001';
  end if;

  -- A grading job that was running during the purge may have written grades since step 1.
  delete from public.grades g
  where (g.subject_type = 'submission' and g.subject_id = any (st.submission_ids))
     or (g.subject_type = 'interview' and g.subject_id = any (st.interview_ids));
  delete from public.grade_summaries g
  where (g.subject_type = 'submission' and g.subject_id = any (st.submission_ids))
     or (g.subject_type = 'interview' and g.subject_id = any (st.interview_ids));
  delete from public.grading_jobs g
  where (g.subject_type = 'submission' and g.subject_id = any (st.submission_ids))
     or (g.subject_type = 'interview' and g.subject_id = any (st.interview_ids));

  for col in
    select c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.data_type = 'uuid' and t.table_type = 'BASE TABLE'
      and c.table_name <> 'retention_purges'
  loop
    execute format('select exists (select 1 from public.%I where %I = $1)', col.table_name, col.column_name)
      into hit using p_user_id;
    if hit then
      raise exception 'purge_left_rows: %.%', col.table_name, col.column_name using errcode = 'P0001';
    end if;
  end loop;

  prefixes := array[p_user_id::text] || array(select x::text from unnest(st.submission_ids || st.interview_ids) x);
  if exists (
    select 1 from storage.objects o
    where o.owner_id = p_user_id::text
       or split_part(o.name, '/', 1) = any (prefixes)
  ) then
    raise exception 'purge_left_storage' using errcode = 'P0001';
  end if;

  -- GoTrue's audit log keeps the e-mail address. Skipped (and noted) where the platform
  -- doesn't let this role touch it.
  begin
    delete from auth.audit_log_entries a
    where a.payload ->> 'actor_id' = p_user_id::text
       or a.payload -> 'traits' ->> 'user_id' = p_user_id::text;
    get diagnostics audit_rows = row_count;
  exception when insufficient_privilege or undefined_table then
    audit_note := 'auth audit log not cleared: ' || sqlerrm;
  end;

  insert into public.purge_log (user_id_hash, scope, detail)
  values (st.user_id_hash, 'candidate', st.counts || coalesce(p_detail, '{}') || jsonb_build_object(
    'started_at', st.started_at,
    'purge_after', st.purge_after,
    'reason', st.reason,
    'attempts', st.attempts + 1,
    'auth_audit_rows_deleted', audit_rows) ||
    case when audit_note is null then '{}'::jsonb else jsonb_build_object('note', audit_note) end)
  returning id into log_id;

  delete from public.retention_purges where user_id = p_user_id;
  return log_id;
end;
$$;
revoke execute on function public.retention_finish_purge(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.retention_finish_purge(uuid, jsonb) to service_role;

-- ───────────────────────── Adverse impact (docs/09 §9) ─────────────────────────
-- Replaces the Wave 4 draft: counts only applications DECIDED at the stage (the latest
-- advance/reject there; holds and undecided applications are left out), excludes admins,
-- filters by cohort (applications created in [p_from, p_to)) and role, and never returns
-- counts for a group under 30 (p_min_n can raise the floor, never lower it). Admins can't read
-- demographics rows; this aggregate is the only way the data leaves the table.
drop function if exists public.adverse_impact_report(text, text, int);
create or replace function public.adverse_impact_report(
  p_stage text,
  p_dimension text,
  p_min_n int default 30,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_role_slug text default null
)
returns table (grp text, candidates bigint, advanced bigint, rate numeric, suppressed boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  min_n int := greatest(coalesce(p_min_n, 30), 30);
begin
  if not public.is_admin() then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  if p_dimension not in ('population_group', 'gender', 'disability') then
    raise exception 'invalid_dimension' using errcode = 'P0001';
  end if;
  if p_stage not in ('interview', 'quiz', 'work_1', 'work_2', 'grading', 'shortlist', 'live', 'offer') then
    raise exception 'invalid_stage' using errcode = 'P0001';
  end if;
  return query execute format($f$
    with outcome as (
      select distinct on (a.id) a.id, a.user_id, d.decision
      from public.applications a
      join public.decisions d on d.application_id = a.id and d.stage = $1 and d.decision in ('advance', 'reject')
      left join public.roles r on r.id = a.role_id
      where ($3::timestamptz is null or a.created_at >= $3)
        and ($4::timestamptz is null or a.created_at < $4)
        and ($5::text is null or r.slug = $5)
        and not exists (select 1 from public.admins ad where ad.user_id = a.user_id)
      order by a.id, d.decided_at desc
    ), g as (
      select coalesce(dm.%1$I, 'not_disclosed') as grp,
             count(*)::bigint as n,
             count(*) filter (where o.decision = 'advance')::bigint as adv
      from outcome o
      left join public.demographics dm on dm.user_id = o.user_id
      group by 1
    )
    select g.grp,
           case when g.n >= $2 then g.n end,
           case when g.n >= $2 then g.adv end,
           case when g.n >= $2 then round(g.adv::numeric / g.n, 3) end,
           g.n < $2
    from g order by g.grp
  $f$, p_dimension) using p_stage, min_n, p_from, p_to, p_role_slug;
end;
$$;
revoke execute on function public.adverse_impact_report(text, text, int, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.adverse_impact_report(text, text, int, timestamptz, timestamptz, text) to authenticated;

-- How many candidates disclosed each dimension (never per-person, never per category).
create or replace function public.demographics_coverage()
returns table (candidates bigint, respondents bigint, dimension text, disclosed bigint, prefer_not bigint, not_answered bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  return query
  with base as (
    select distinct c.user_id from public.consents c
    where not exists (select 1 from public.admins ad where ad.user_id = c.user_id)
  ), resp as (
    select d.population_group, d.gender, d.disability
    from public.demographics d join base b on b.user_id = d.user_id
  ), vals as (
    select x.dim, x.v
    from resp r
    cross join lateral (values ('population_group', r.population_group), ('gender', r.gender), ('disability', r.disability)) x(dim, v)
  )
  select (select count(*) from base)::bigint,
         (select count(*) from resp)::bigint,
         dims.dim,
         count(vals.v) filter (where vals.v <> 'prefer_not')::bigint,
         count(vals.v) filter (where vals.v = 'prefer_not')::bigint,
         ((select count(*) from resp) - count(vals.v))::bigint
  from (values ('population_group'), ('gender'), ('disability')) dims(dim)
  left join vals on vals.dim = dims.dim
  group by dims.dim
  order by dims.dim;
end;
$$;
revoke execute on function public.demographics_coverage() from public, anon;
grant execute on function public.demographics_coverage() to authenticated;

alter table public.demographics add column if not exists notice_version text;

-- ───────────────────────── Reliability (KR-20) inputs ─────────────────────────
-- Sufficient statistics per form and cohort (calendar month the attempt started; cohort null =
-- all months) from submitted attempts plus the anonymised archive. Items are the positions
-- (each position has a fixed tier, see lib/reasoning/blueprint.ts); unanswered = wrong.
-- lib/stats/kr20.ts turns them into KR-20. Security invoker: RLS limits it to admins.
create or replace function public.reasoning_kr20_inputs()
returns table (form text, cohort date, attempts bigint, k int, sum_pq numeric, var_total numeric, mean_total numeric)
language sql
stable
set search_path = ''
as $$
  with resp as (
    select a.id::text as attempt, a.form, date_trunc('month', a.started_at)::date as cohort, r.position,
           case when r.correct then 1 else 0 end as x
    from public.reasoning_responses r
    join public.reasoning_attempts a on a.id = r.attempt_id
    where a.submitted_at is not null
    union all
    select z.attempt_ref::text, z.form, z.cohort_month, z.position, case when z.correct then 1 else 0 end
    from public.item_response_archive z
    where z.source = 'reasoning' and z.attempt_ref is not null and z.position is not null and z.form is not null
  ), tagged as (
    select attempt, form, cohort, position, x from resp
    union all
    select attempt, form, null::date, position, x from resp
  ), totals as (
    select t.form, t.cohort, t.attempt, sum(t.x)::numeric as total from tagged t group by t.form, t.cohort, t.attempt
  ), items as (
    select t.form, t.cohort, count(*)::int as k, sum(t.p * (1 - t.p)) as sum_pq
    from (select form, cohort, position, avg(x::numeric) as p from tagged group by form, cohort, position) t
    group by t.form, t.cohort
  )
  select t.form, t.cohort, count(*)::bigint, i.k, round(i.sum_pq, 6), round(var_pop(t.total), 6), round(avg(t.total), 3)
  from totals t
  join items i on i.form = t.form and i.cohort is not distinct from t.cohort
  group by t.form, t.cohort, i.k, i.sum_pq
  order by t.form, t.cohort nulls first;
$$;
revoke execute on function public.reasoning_kr20_inputs() from public, anon;
grant execute on function public.reasoning_kr20_inputs() to authenticated;

-- ───────────────────────── Reasoning item statistics (docs/04 §4) ─────────────────────────
-- Replaces the Wave 4 draft: also counts archived (purged) responses, so purges don't erase
-- the bank's history, and uses the corrected point-biserial (item vs the rest of the score),
-- which doesn't inflate discrimination by correlating an item with itself.
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
    where a.submitted_at is not null and r.served_at is not null and a.raw_score is not null
    union all
    select z.item_id, case when z.correct then 1.0 else 0.0 end, z.attempt_score
    from public.item_response_archive z
    where z.source = 'reasoning' and z.served and z.item_id is not null and z.attempt_score is not null
  ), agg as (
    select item_id, count(*)::int as n, avg(x) as p, corr(x, total - x) as pb
    from resp group by item_id
  )
  update public.reasoning_items i
  set exposures = agg.n,
      difficulty_p = case when agg.n >= 40 then round(agg.p, 3) end,
      discrimination = case when agg.n >= 40 then round(agg.pb::numeric, 3) end
  from agg
  where agg.item_id = i.id
    and (i.exposures, i.difficulty_p, i.discrimination) is distinct from
        (agg.n, case when agg.n >= 40 then round(agg.p, 3) end, case when agg.n >= 40 then round(agg.pb::numeric, 3) end);
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.refresh_reasoning_item_stats() from public, anon, authenticated;
grant execute on function public.refresh_reasoning_item_stats() to service_role;
