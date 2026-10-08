-- Wave 4: retention purge, compliance reporting and item statistics (docs/12, docs/09 §9, docs/04 §4).
-- Re-runnable: every object is created with "if not exists" / "or replace" / drop-then-create.
--
-- Retention rules (lib/consent/notice.ts, docs/12 §1 "Retention automation"; details at
-- retention_schedule below):
--   * not appointed: purged 6 months after the application ended for retention (it closed, its
--     role's hiring round closed, or it was abandoned: no activity for 6 months), or 6 months
--     after the last activity of someone who never applied;
--   * talent-pool opt-in (the latest consents row decides): 12 months instead;
--   * never queued: admins, former staff named on decisions/scorecards etc., anyone with an
--     application still in play, appointed candidates (advanced out of the offer stage: employee
--     records, outside this purge) and anyone with an open review request.
-- A purge is reversible until the auth user is deleted, re-checks the rules before that, and
-- blocks re-opening the person's applications while it runs. lib/stats/retention.ts mirrors the
-- date rules for unit tests.

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

-- ───────────────────────── Hiring rounds ─────────────────────────
-- A role's hiring round closes when an admin makes the role inactive (/admin/roles) and re-opens
-- if the role is made active again. Applications left in play when the round closed reach the
-- retention clock from then (see retention_schedule): nobody has to reject every straggler.
alter table public.roles add column if not exists round_closed_at timestamptz;

create or replace function public.role_round_closed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.active then
    new.round_closed_at := null;
  elsif tg_op = 'INSERT' or old.active then
    new.round_closed_at := coalesce(new.round_closed_at, now());
  end if;
  return new;
end;
$$;
revoke execute on function public.role_round_closed_at() from public, anon, authenticated;
drop trigger if exists roles_round_closed_at on public.roles;
create trigger roles_round_closed_at
  before insert or update of active on public.roles
  for each row execute function public.role_round_closed_at();

alter table public.roles disable trigger roles_updated_at;
update public.roles set round_closed_at = updated_at where not active and round_closed_at is null;
alter table public.roles enable trigger roles_updated_at;

-- ───────────────────────── Activity and staff ─────────────────────────
-- The latest thing that happened on an application, by the candidate or by an admin: stage
-- attempts, drafts, submissions, decisions, review requests, live scorecards. (updated_at moves
-- on every composite refresh, so it doesn't count.)
create or replace function public.application_last_activity(p_application_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    a.created_at,
    a.closed_at,
    (select max(d.decided_at) from public.decisions d where d.application_id = a.id),
    (select max(greatest(s.created_at, s.started_at, s.ended_at)) from public.interview_sessions s where s.application_id = a.id),
    (select max(greatest(q.created_at, q.started_at, q.submitted_at)) from public.quiz_attempts q where q.application_id = a.id),
    (select max(greatest(w.created_at, w.unlocked_at, w.started_at, w.submitted_at, w.draft_saved_at))
       from public.work_attempts w where w.application_id = a.id),
    (select max(sb.created_at) from public.submissions sb join public.work_attempts w on w.id = sb.attempt_id where w.application_id = a.id),
    (select max(greatest(ps.created_at, ps.started_at, ps.ended_at))
       from public.persona_sessions ps join public.work_attempts w on w.id = ps.attempt_id where w.application_id = a.id),
    (select max(greatest(rr.created_at, rr.responded_at)) from public.review_requests rr where rr.application_id = a.id),
    (select max(greatest(ls.created_at, ls.updated_at, ls.submitted_at)) from public.live_scorecards ls where ls.application_id = a.id)
  )
  from public.applications a
  where a.id = p_application_id;
$$;
revoke execute on function public.application_last_activity(uuid) from public, anon, authenticated;
grant execute on function public.application_last_activity(uuid) to service_role;

-- Accounts named as staff in a column that keeps the reference (no ON DELETE): deciders,
-- raters, responders, resolvers, calibration and harness runners. Their name on a decision is a
-- staff record, not candidate data, and deleting them would fail on every run, so the
-- candidate purge leaves them out (a former admin is handled by hand; /admin/compliance counts
-- them). Found from the foreign keys, so a new staff column is covered without a change here.
create or replace function public.retention_staff_ids()
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  fk record;
begin
  for fk in
    select c.conrelid::regclass::text as tbl, a.attname::text as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.confrelid = 'auth.users'::regclass
      and c.connamespace = 'public'::regnamespace
      and c.confdeltype in ('a', 'r')
      and cardinality(c.conkey) = 1
  loop
    return query execute format('select distinct %I from %s where %I is not null', fk.col, fk.tbl, fk.col);
  end loop;
end;
$$;
revoke execute on function public.retention_staff_ids() from public, anon, authenticated;
grant execute on function public.retention_staff_ids() to service_role;

-- ───────────────────────── Retention schedule ─────────────────────────
alter table public.retention_queue add column if not exists basis_at timestamptz;

-- Who is due for purging and when, computed live (read-only). Per application, the clock starts
-- when it ended for retention:
--   * closed (rejected, withdrawn, lapsed, or at stage closed): when it closed, or when the
--     role's round closed if that was later (the notice: "6 months after the round closes");
--   * still in play on a role whose round has closed: the later of the round's close and the
--     application's last activity;
--   * still in play on an open round with no activity for 6 months: abandoned, so it ends 6
--     months after the last activity (it is listed on /admin/compliance well before that);
--   * otherwise it is in play and the person is not queued.
-- The person's clock is the latest of those ends and their own last activity; the purge is 6
-- months later, 12 with the talent-pool opt-in on their latest consent. Never queued: admins,
-- former staff (above), appointed candidates and anyone with an open review request.
-- lib/stats/retention.ts mirrors these rules for unit tests.
create or replace function public.retention_schedule(p_user_ids uuid[] default null)
returns table (user_id uuid, purge_after date, reason text, basis text, basis_at timestamptz, talent_pool boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with staff as materialized (
    select s.id from public.retention_staff_ids() s(id)
  ), people as (
    select u.id, u.created_at
    from auth.users u
    where (p_user_ids is null or u.id = any (p_user_ids))
      and not exists (select 1 from public.admins ad where ad.user_id = u.id)
      and not exists (select 1 from staff s where s.id = u.id)
      and not exists (
        select 1 from public.applications a
        where a.user_id = u.id and a.stage = 'closed' and a.status = 'advanced')
      and not exists (select 1 from public.review_requests rr where rr.user_id = u.id and rr.status = 'open')
  ), apps as (
    select a.user_id,
      (a.status in ('rejected', 'withdrawn', 'lapsed') or a.stage = 'closed') as is_closed,
      coalesce(a.closed_at, (select max(d.decided_at) from public.decisions d where d.application_id = a.id), a.updated_at) as closed_at,
      r.round_closed_at,
      public.application_last_activity(a.id) as active_at
    from public.applications a
    join people p on p.id = a.user_id
    left join public.roles r on r.id = a.role_id
  ), ends as (
    select a.user_id,
      case
        when a.is_closed then greatest(a.closed_at, a.round_closed_at)
        when a.round_closed_at is not null then greatest(a.round_closed_at, a.active_at)
        when (a.active_at at time zone 'UTC') + interval '6 months' <= (now() at time zone 'UTC')
          then ((a.active_at at time zone 'UTC') + interval '6 months') at time zone 'UTC'
      end as ended_at,
      case
        when a.is_closed and a.round_closed_at > a.closed_at then 'round_closed'
        when a.is_closed then 'application_closed'
        when a.round_closed_at is not null then 'round_closed'
        else 'inactive'
      end as basis
    from apps a
  ), per_person as (
    select e.user_id,
      bool_or(e.ended_at is null) as in_play,
      max(e.ended_at) as ended_at,
      (array_agg(e.basis order by e.ended_at desc))[1] as basis
    from ends e
    group by e.user_id
  ), facts as (
    select p.id, pp.ended_at, pp.basis,
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
    left join per_person pp on pp.user_id = p.id
    where not coalesce(pp.in_play, false)
  )
  select f.id,
         ((greatest(f.ended_at, f.last_activity) at time zone 'UTC')
           + case when f.pool then interval '12 months' else interval '6 months' end)::date,
         case when f.pool then 'Talent pool: 12 months after ' else 'Not appointed: 6 months after ' end
           || case coalesce(f.basis, 'no_application')
                when 'application_closed' then 'the application closed'
                when 'round_closed' then 'the role''s hiring round closed'
                when 'inactive' then 'the application lapsed (no activity for 6 months)'
                else 'the last activity (never applied)'
              end,
         coalesce(f.basis, 'no_application'),
         greatest(f.ended_at, f.last_activity),
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

-- Applications still in play with no activity for p_months (or on a closed round), for the
-- admin to close with a decision before retention treats them as lapsed. Admin-only.
create or replace function public.retention_stale_applications(p_months int default 3)
returns table (application_id uuid, user_id uuid, role_slug text, stage text, status text,
               last_activity timestamptz, round_closed_at timestamptz, retention_from timestamptz)
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
  select a.id, a.user_id, r.slug, a.stage, a.status, x.at, r.round_closed_at,
         case when r.round_closed_at is not null then greatest(r.round_closed_at, x.at)
              else ((x.at at time zone 'UTC') + interval '6 months') at time zone 'UTC' end
  from public.applications a
  left join public.roles r on r.id = a.role_id
  cross join lateral (select public.application_last_activity(a.id) as at) x
  where not (a.status in ('rejected', 'withdrawn', 'lapsed') or a.stage = 'closed')
    and not exists (select 1 from public.admins ad where ad.user_id = a.user_id)
    and (r.round_closed_at is not null
         or (x.at at time zone 'UTC') + make_interval(months => greatest(coalesce(p_months, 3), 1)) <= (now() at time zone 'UTC'))
  order by x.at, a.id;
end;
$$;
revoke execute on function public.retention_stale_applications(int) from public, anon;
grant execute on function public.retention_stale_applications(int) to authenticated;

-- How many former staff (not admins any more) the purge leaves out. Admin-only.
create or replace function public.retention_former_staff_count()
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  n bigint;
begin
  if not public.is_admin() then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  select count(*) into n
  from public.retention_staff_ids() s(id)
  where not exists (select 1 from public.admins ad where ad.user_id = s.id)
    and exists (select 1 from auth.users u where u.id = s.id);
  return n;
end;
$$;
revoke execute on function public.retention_former_staff_count() from public, anon;
grant execute on function public.retention_former_staff_count() to authenticated;

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
-- archived_at is kept to the month, so a row's time can't be matched to one purge_log row.
update public.item_response_archive set archived_at = date_trunc('month', archived_at)
where archived_at <> date_trunc('month', archived_at);

-- A purge first writes a person's anonymised answers here, tagged with a random purge_ref that
-- only the in-progress purge row knows. A cancelled purge removes them; a finished one leaves
-- them untagged in effect (its purge row is gone). They move to item_response_archive only in
-- batches of at least 5 people, shuffled, so the archive's row order and ids can't be lined up
-- with the purge log or the decision archive. Nobody but the service role reads this table;
-- the statistics functions count the finished purges' rows from here as well.
create table if not exists public.retention_archive_pending (
  purge_ref uuid not null,
  source text not null check (source in ('reasoning', 'quiz')),
  item_id uuid,
  family_or_topic text,
  tier text,
  correct boolean,
  seconds numeric,
  attempt_ref uuid,
  form text,
  position int,
  served boolean,
  attempt_score numeric,
  cohort_month date
);
create index if not exists retention_archive_pending_ref_idx on public.retention_archive_pending (purge_ref);
alter table public.retention_archive_pending enable row level security;
revoke all on public.retention_archive_pending from anon, authenticated;

-- ───────────────────────── Purge state (resumable) ─────────────────────────
-- One row per purge in progress. Deliberately no foreign key to auth.users: the row has to
-- outlive the auth user's deletion so a crash after it can still finish (storage, purge_log).
-- Deleted when the purge completes (or is cancelled), so no raw user id stays behind.
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
alter table public.retention_purges add column if not exists archive_ref uuid not null default gen_random_uuid();
alter table public.retention_purges add column if not exists decision_archive_ids uuid[] not null default '{}';
create unique index if not exists retention_purges_archive_ref_idx on public.retention_purges (archive_ref);
alter table public.retention_purges enable row level security;
drop policy if exists retention_purges_admin_select on public.retention_purges;
create policy retention_purges_admin_select on public.retention_purges for select to authenticated using (public.is_admin());
grant select on public.retention_purges to authenticated;

-- While a purge is in progress nobody can re-open, start or dispute an application of that
-- person (the purge was due; it either finishes or, if something else made them ineligible, is
-- cancelled by the next re-check). Security definer: the check must see retention_purges even
-- when a candidate's own insert fires it.
create or replace function public.retention_guard_application()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status and new.stage is not distinct from old.stage then
    return new;
  end if;
  if exists (select 1 from public.retention_purges r where r.user_id = new.user_id) then
    raise exception 'purge_in_progress: this person''s information is being deleted under the retention policy'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function public.retention_guard_application() from public, anon, authenticated;
drop trigger if exists applications_retention_guard on public.applications;
create trigger applications_retention_guard
  before insert or update of status, stage on public.applications
  for each row execute function public.retention_guard_application();

create or replace function public.retention_guard_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.retention_purges r where r.user_id = new.user_id) then
    raise exception 'purge_in_progress: this person''s information is being deleted under the retention policy'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function public.retention_guard_insert() from public, anon, authenticated;
drop trigger if exists review_requests_retention_guard on public.review_requests;
create trigger review_requests_retention_guard
  before insert on public.review_requests
  for each row execute function public.retention_guard_insert();

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

-- null when the person is still due for purging today, otherwise why not.
create or replace function public.retention_recheck(p_user_id uuid, p_today date)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s record;
begin
  select * into s from public.retention_schedule(array[p_user_id]);
  if not found then
    return 'not_eligible';
  end if;
  if s.purge_after > p_today then
    return 'not_due';
  end if;
  return null;
end;
$$;
revoke execute on function public.retention_recheck(uuid, date) from public, anon, authenticated;
grant execute on function public.retention_recheck(uuid, date) to service_role;

-- Undoes a purge that hasn't deleted the auth user yet (the person is no longer due): removes
-- the archived decisions and held answers it wrote, logs the cancellation under the hashed id
-- and drops the state row. Nothing irreversible has happened before the auth user's deletion.
create or replace function public.retention_cancel(p_user_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  st public.retention_purges%rowtype;
begin
  select * into st from public.retention_purges where user_id = p_user_id for update;
  if not found then
    return;
  end if;
  if st.auth_deleted_at is not null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'purge_cannot_cancel: the auth user is already deleted' using errcode = 'P0001';
  end if;
  delete from public.decision_archive where id = any (st.decision_archive_ids);
  delete from public.retention_archive_pending where purge_ref = st.archive_ref;
  insert into public.purge_log (user_id_hash, scope, detail)
  values (st.user_id_hash, 'cancelled', jsonb_build_object(
    'reason', p_reason, 'started_at', st.started_at, 'purge_after', st.purge_after, 'attempts', st.attempts));
  delete from public.retention_purges where user_id = p_user_id;
end;
$$;
revoke execute on function public.retention_cancel(uuid, text) from public, anon, authenticated;
grant execute on function public.retention_cancel(uuid, text) to service_role;

-- Step 1 of a purge, in one transaction: re-check the rules, archive the decision log (hashed
-- id) and hold the anonymised item responses, and record the purge. Reversible until the auth
-- user is deleted. Resuming re-checks the rules first and cancels the purge if they no longer
-- apply. Returns {status: started|resumed|cancelled|not_due|not_eligible, ...state}.
create or replace function public.retention_begin_purge(p_user_id uuid, p_hash text, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  st public.retention_purges%rowtype;
  s record;
  why text;
  v_ref uuid := gen_random_uuid();
  v_dec uuid[];
  v_subs uuid[];
  v_sessions uuid[];
  n_rea int;
  n_quiz int;
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_hash' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('retention:' || p_user_id::text, 0));

  select * into st from public.retention_purges where user_id = p_user_id;
  if found then
    if st.auth_deleted_at is null and exists (select 1 from auth.users u where u.id = p_user_id) then
      why := public.retention_recheck(p_user_id, p_today);
      if why is not null then
        perform public.retention_cancel(p_user_id, why);
        return jsonb_build_object('status', 'cancelled', 'user_id', p_user_id, 'reason', why);
      end if;
    end if;
    return to_jsonb(st) || jsonb_build_object('status', 'resumed');
  end if;

  select * into s from public.retention_schedule(array[p_user_id]);
  if not found then
    return jsonb_build_object('status', 'not_eligible', 'user_id', p_user_id);
  end if;
  if s.purge_after > p_today then
    return jsonb_build_object('status', 'not_due', 'user_id', p_user_id, 'purge_after', s.purge_after);
  end if;

  with ins as (
    insert into public.decision_archive (user_id_hash, role_slug, stage, decision, reason, decided_at)
    select p_hash, r.slug, d.stage, d.decision, d.reason, d.decided_at
    from public.decisions d
    join public.applications a on a.id = d.application_id
    left join public.roles r on r.id = a.role_id
    where a.user_id = p_user_id
    returning id
  )
  select coalesce(array_agg(ins.id), '{}') into v_dec from ins;

  -- Submitted attempts only; unanswered items count as wrong (docs/04 §2).
  with att as materialized (
    select t.id, gen_random_uuid() as ref, t.form, t.raw_score, date_trunc('month', t.started_at)::date as cohort
    from public.reasoning_attempts t
    where t.user_id = p_user_id and t.submitted_at is not null
  )
  insert into public.retention_archive_pending
    (purge_ref, source, item_id, family_or_topic, tier, correct, seconds, attempt_ref, form, position, served, attempt_score, cohort_month)
  select v_ref, 'reasoning', r.item_id, r.family, r.tier, coalesce(r.correct, false),
         case when r.answered_at is not null and r.served_at is not null
              then round(extract(epoch from r.answered_at - r.served_at)::numeric, 1) end,
         att.ref, att.form, r.position, r.served_at is not null, att.raw_score, att.cohort
  from public.reasoning_responses r join att on att.id = r.attempt_id;
  get diagnostics n_rea = row_count;

  with att as materialized (
    select t.id, gen_random_uuid() as ref, t.raw_score, date_trunc('month', t.started_at)::date as cohort
    from public.quiz_attempts t
    where t.user_id = p_user_id and t.submitted_at is not null
  )
  insert into public.retention_archive_pending
    (purge_ref, source, item_id, family_or_topic, tier, correct, seconds, attempt_ref, form, position, served, attempt_score, cohort_month)
  select v_ref, 'quiz', r.item_id, r.topic, null, coalesce(r.correct, false),
         case when r.answered_at is not null and r.served_at is not null
              then round(extract(epoch from r.answered_at - r.served_at)::numeric, 1) end,
         att.ref, null, r.position, r.served_at is not null, att.raw_score, att.cohort
  from public.quiz_responses r join att on att.id = r.attempt_id;
  get diagnostics n_quiz = row_count;

  select coalesce(array_agg(x.id), '{}') into v_subs from public.submissions x where x.user_id = p_user_id;
  select coalesce(array_agg(x.id), '{}') into v_sessions from public.interview_sessions x where x.user_id = p_user_id;

  insert into public.retention_purges
    (user_id, user_id_hash, purge_after, reason, submission_ids, interview_ids, counts, archive_ref, decision_archive_ids)
  values (p_user_id, p_hash, s.purge_after, s.reason, v_subs, v_sessions, jsonb_build_object(
    'decisions_archived', cardinality(v_dec),
    'reasoning_responses_archived', n_rea,
    'quiz_responses_archived', n_quiz), v_ref, v_dec)
  returning * into st;
  return to_jsonb(st) || jsonb_build_object('status', 'started');
end;
$$;
revoke execute on function public.retention_begin_purge(uuid, text, date) from public, anon, authenticated;
grant execute on function public.retention_begin_purge(uuid, text, date) to service_role;

-- Just before the auth user is deleted (the server has banned the account by then): re-check
-- the rules (cancel if they no longer apply) and refresh the submission and interview ids from
-- the live tables, so work created since step 1 is covered by the storage and grade clean-up.
-- Returns {status: ready|cancelled, submission_ids, interview_ids}.
create or replace function public.retention_prepare_auth_delete(p_user_id uuid, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  st public.retention_purges%rowtype;
  why text;
  v_subs uuid[];
  v_sessions uuid[];
begin
  perform pg_advisory_xact_lock(hashtextextended('retention:' || p_user_id::text, 0));
  select * into st from public.retention_purges where user_id = p_user_id for update;
  if not found then
    raise exception 'purge_not_started' using errcode = 'P0001';
  end if;
  if exists (select 1 from auth.users u where u.id = p_user_id) then
    why := public.retention_recheck(p_user_id, p_today);
    if why is not null then
      perform public.retention_cancel(p_user_id, why);
      return jsonb_build_object('status', 'cancelled', 'reason', why);
    end if;
  end if;
  select coalesce(array_agg(distinct t.x), '{}') into v_subs
  from (select unnest(st.submission_ids) union select s.id from public.submissions s where s.user_id = p_user_id) t(x);
  select coalesce(array_agg(distinct t.x), '{}') into v_sessions
  from (select unnest(st.interview_ids) union select s.id from public.interview_sessions s where s.user_id = p_user_id) t(x);
  update public.retention_purges
  set submission_ids = v_subs, interview_ids = v_sessions, updated_at = now()
  where user_id = p_user_id;
  return jsonb_build_object('status', 'ready', 'submission_ids', v_subs, 'interview_ids', v_sessions);
end;
$$;
revoke execute on function public.retention_prepare_auth_delete(uuid, date) from public, anon, authenticated;
grant execute on function public.retention_prepare_auth_delete(uuid, date) to service_role;

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
      storage_done_at = case when p_step = 'storage' then now() else storage_done_at end,
      auth_deleted_at = case when p_step = 'auth' then coalesce(auth_deleted_at, now()) else auth_deleted_at end,
      attempts = attempts + case when p_step = 'error' then 1 else 0 end,
      last_error = case when p_step = 'error' then left(p_error, 1000) when p_step = 'auth' then null else last_error end,
      updated_at = now()
  where user_id = p_user_id;
end;
$$;
revoke execute on function public.retention_note_progress(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.retention_note_progress(uuid, text, jsonb, text) to service_role;

-- Moves held answers of finished purges into item_response_archive, shuffled, once at least
-- p_min_people finished purges are waiting (5 by default; the service role can pass 1 to flush).
-- archived_at is the month. Returns the number of rows moved.
create or replace function public.retention_release_archive(p_min_people int default 5)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  waiting int;
  moved int;
begin
  perform pg_advisory_xact_lock(hashtextextended('retention:release', 0));
  select count(distinct p.purge_ref) into waiting
  from public.retention_archive_pending p
  where not exists (select 1 from public.retention_purges r where r.archive_ref = p.purge_ref);
  if waiting = 0 or waiting < greatest(coalesce(p_min_people, 5), 1) then
    return 0;
  end if;
  with gone as (
    delete from public.retention_archive_pending p
    where not exists (select 1 from public.retention_purges r where r.archive_ref = p.purge_ref)
    returning p.*
  )
  insert into public.item_response_archive
    (source, item_id, family_or_topic, tier, correct, seconds, attempt_ref, form, position, served, attempt_score, cohort_month, archived_at)
  select g.source, g.item_id, g.family_or_topic, g.tier, g.correct, g.seconds, g.attempt_ref, g.form, g.position,
         g.served, g.attempt_score, g.cohort_month, date_trunc('month', now())
  from gone g
  order by random();
  get diagnostics moved = row_count;
  return moved;
end;
$$;
revoke execute on function public.retention_release_archive(int) from public, anon, authenticated;
grant execute on function public.retention_release_archive(int) to service_role;

-- Last step, after the auth user and the storage objects are gone: delete the grades (they have
-- no foreign key and quote the candidate's work), check nothing keyed by the user survived (any
-- uuid column in public, any storage object), clear the auth audit log entries that name them,
-- write purge_log, drop the state row and release held answers if enough are waiting. Raises (so
-- the purge stays in progress, visible on /admin/compliance) if anything is left; the next run
-- clears storage again before calling this. Returns the purge_log id.
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
  n_grades int;
  n_sum int;
  n_jobs int;
begin
  perform pg_advisory_xact_lock(hashtextextended('retention:' || p_user_id::text, 0));
  select * into st from public.retention_purges where user_id = p_user_id for update;
  if not found then
    return null;  -- already finished
  end if;
  if exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'purge_auth_user_still_exists' using errcode = 'P0001';
  end if;

  delete from public.grades g
  where (g.subject_type = 'submission' and g.subject_id = any (st.submission_ids))
     or (g.subject_type = 'interview' and g.subject_id = any (st.interview_ids));
  get diagnostics n_grades = row_count;
  delete from public.grade_summaries g
  where (g.subject_type = 'submission' and g.subject_id = any (st.submission_ids))
     or (g.subject_type = 'interview' and g.subject_id = any (st.interview_ids));
  get diagnostics n_sum = row_count;
  delete from public.grading_jobs g
  where (g.subject_type = 'submission' and g.subject_id = any (st.submission_ids))
     or (g.subject_type = 'interview' and g.subject_id = any (st.interview_ids));
  get diagnostics n_jobs = row_count;

  for col in
    select c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.data_type = 'uuid' and t.table_type = 'BASE TABLE'
      and c.table_name not in ('retention_purges', 'retention_archive_pending')
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
    'grades_deleted', coalesce((st.counts ->> 'grades_deleted')::int, 0) + n_grades,
    'grade_summaries_deleted', coalesce((st.counts ->> 'grade_summaries_deleted')::int, 0) + n_sum,
    'grading_jobs_deleted', coalesce((st.counts ->> 'grading_jobs_deleted')::int, 0) + n_jobs,
    'started_at', st.started_at,
    'purge_after', st.purge_after,
    'reason', st.reason,
    'attempts', st.attempts + 1,
    'auth_audit_rows_deleted', audit_rows) ||
    case when audit_note is null then '{}'::jsonb else jsonb_build_object('note', audit_note) end)
  returning id into log_id;

  delete from public.retention_purges where user_id = p_user_id;
  perform public.retention_release_archive(5);
  return log_id;
end;
$$;
revoke execute on function public.retention_finish_purge(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.retention_finish_purge(uuid, jsonb) to service_role;

-- ───────────────────────── Adverse impact (docs/09 §9) ─────────────────────────
-- Replaces the Wave 4 draft: counts only applications DECIDED at the stage (the latest
-- advance/reject there; holds and undecided applications are left out) and excludes admins.
-- Admins can't read demographics rows; this aggregate is the only way the data leaves the
-- table, and it is built so that it can't single anyone out (special personal information,
-- POPIA s26; the separate consent promises "only totals for groups of 30 or more"):
--   1. a group is returned only with at least 30 decided applications (p_min_n can raise the
--      floor, never lower it);
--   2. a group under the floor is never named or counted, not even as "hidden": its name or
--      size, together with a narrow cohort, would point at the people in it;
--   3. complementary suppression: if any returned group's complement (everyone decided in the
--      cohort minus that group) is under the floor, including zero, nothing is returned for
--      that stage and dimension, because an admin who knows the cohort's size from the pipeline
--      could otherwise work out the few people outside the group;
--   4. cohorts are whole calendar months of application (UTC) and/or a role (a hiring round),
--      never free date ranges, so two windows a day apart can't be subtracted.
-- Residual risk, accepted and documented on /admin/compliance: nested cohorts (one month vs all
-- months, one role vs all roles) and the same report read before and after one decision can
-- still be subtracted when the difference is tiny. Admins are told not to do this; the report
-- is for cohort reviews, not for looking at individuals.
drop function if exists public.adverse_impact_report(text, text, int);
drop function if exists public.adverse_impact_report(text, text, int, timestamptz, timestamptz, text);
drop function if exists public.adverse_impact_report(text, text, int, date, text);
create function public.adverse_impact_report(
  p_stage text,
  p_dimension text,
  p_min_n int default 30,
  p_cohort_month date default null,
  p_role_slug text default null
)
returns table (grp text, candidates bigint, advanced bigint, rate numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  min_n int := greatest(coalesce(p_min_n, 30), 30);
  v_from timestamptz := case when p_cohort_month is null then null
                             else date_trunc('month', p_cohort_month::timestamp) at time zone 'UTC' end;
  v_to timestamptz := case when p_cohort_month is null then null
                           else (date_trunc('month', p_cohort_month::timestamp) + interval '1 month') at time zone 'UTC' end;
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
    ), total as (
      select coalesce(sum(g.n), 0)::bigint as n from g
    ), shown as (
      select g.* from g where g.n >= $2
    )
    select s.grp, s.n, s.adv, round(s.adv::numeric / s.n, 3)
    from shown s
    where not exists (select 1 from shown x cross join total t where t.n - x.n < $2)
    order by s.grp
  $f$, p_dimension) using p_stage, min_n, v_from, v_to, p_role_slug;
end;
$$;
revoke execute on function public.adverse_impact_report(text, text, int, date, text) from public, anon;
grant execute on function public.adverse_impact_report(text, text, int, date, text) to authenticated;

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
-- all months) from submitted attempts plus the anonymised answers kept after purges (the archive
-- and finished purges' answers still held for the next shuffled batch). Items are the positions
-- (each position has a fixed tier, see lib/reasoning/blueprint.ts); unanswered = wrong.
-- lib/stats/kr20.ts turns them into KR-20. Security definer (the held answers are not
-- admin-readable rows); it returns nothing to anyone but an admin.
create or replace function public.reasoning_kr20_inputs()
returns table (form text, cohort date, attempts bigint, k int, sum_pq numeric, var_total numeric, mean_total numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with resp as (
    select a.id::text as attempt, a.form, date_trunc('month', a.started_at)::date as cohort, r.position,
           case when r.correct then 1 else 0 end as x
    from public.reasoning_responses r
    join public.reasoning_attempts a on a.id = r.attempt_id
    where a.submitted_at is not null and public.is_admin()
    union all
    select z.attempt_ref::text, z.form, z.cohort_month, z.position, case when z.correct then 1 else 0 end
    from public.item_response_archive z
    where z.source = 'reasoning' and z.attempt_ref is not null and z.position is not null and z.form is not null
      and public.is_admin()
    union all
    select z.attempt_ref::text, z.form, z.cohort_month, z.position, case when z.correct then 1 else 0 end
    from public.retention_archive_pending z
    where z.source = 'reasoning' and z.attempt_ref is not null and z.position is not null and z.form is not null
      and not exists (select 1 from public.retention_purges p where p.archive_ref = z.purge_ref)
      and public.is_admin()
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
-- Replaces the Wave 4 draft: also counts archived (purged) responses, including finished
-- purges' answers still held for the next shuffled batch, so purges don't erase the bank's history, and uses the corrected point-biserial (item vs the rest of the score),
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
    union all
    select z.item_id, case when z.correct then 1.0 else 0.0 end, z.attempt_score
    from public.retention_archive_pending z
    where z.source = 'reasoning' and z.served and z.item_id is not null and z.attempt_score is not null
      and not exists (select 1 from public.retention_purges p where p.archive_ref = z.purge_ref)
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
