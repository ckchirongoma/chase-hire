-- Live stage and grader calibration: review fixes (docs/09 §5 and §8).
--
-- 1. Independent raters: once a panellist has submitted a part they see the other panellists'
--    SUBMITTED cards for it, never their drafts.
-- 2. Scorecard guard: on submit the database checks the scores (integers 1-5, at least one) and
--    computes the total itself (mean 1-5 mapped onto 0-100, as lib/scoring rubricTo100), ignoring
--    the client's total; a draft has no total. One reasoning retest per application.
-- 3. Calibration 'human_only' (docs/09 §8.3, "human-scored only until fixed"): grade_summaries.ai_final
--    false keeps the AI median as evidence but leaves final_score empty until a person scores it.
--    apply_calibration_statuses(run) applies a finished run's statuses to grades already stored.
-- 4. Gold-set human scores: which admin owns rater column 1 and 2 (human_raters).
-- 5. Drift check (docs/09 §8.4): frozen blocks of 25 with their 3 picks, and drift re-scores kept
--    apart from review overrides.
--
-- Re-runnable.

-- ───────────────────────── 1. Draft visibility ─────────────────────────
drop policy if exists live_scorecards_select on public.live_scorecards;
create policy live_scorecards_select on public.live_scorecards for select to authenticated using (
  public.is_admin()
  and (rater = auth.uid()
       or (submitted_at is not null and public.has_submitted_scorecard(application_id, kind))));

-- ───────────────────────── 2. Scorecard guard ─────────────────────────
-- SECURITY DEFINER so the one-retest check sees every panellist's row (RLS hides them).
create or replace function public.live_scorecard_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb;
  valid boolean;
  n int := 0;
  s numeric := 0;
begin
  if tg_op = 'UPDATE' and old.submitted_at is not null then
    raise exception 'scorecard_already_submitted' using errcode = 'P0001';
  end if;
  if new.submitted_at is not null then
    new.submitted_at := now();
  end if;

  if new.kind in ('panel_interview', 'live_defence', 'live_elicitation', 'exec_scenario') then
    if jsonb_typeof(new.scores) is distinct from 'object' then
      raise exception 'scorecard_scores_invalid' using errcode = '22023';
    end if;
    for v in select e.value from jsonb_each(new.scores) e loop
      valid := case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric in (1, 2, 3, 4, 5) else false end;
      if not valid then
        raise exception 'scorecard_scores_invalid' using errcode = '22023';
      end if;
      n := n + 1;
      s := s + (v #>> '{}')::numeric;
    end loop;
    if new.submitted_at is null then
      new.total := null;
    elsif n = 0 then
      raise exception 'scorecard_scores_missing' using errcode = '22023';
    else
      new.total := round(((s / n) - 1) / 4 * 100, 1);
    end if;
  end if;

  if tg_op = 'INSERT' and new.kind = 'reasoning_retest' then
    perform pg_advisory_xact_lock(hashtextextended('live_retest:' || new.application_id::text, 0));
    if exists (select 1 from public.live_scorecards x where x.application_id = new.application_id and x.kind = 'reasoning_retest') then
      raise exception 'retest_already_recorded' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.live_scorecard_guard() from public, anon, authenticated;

-- ───────────────────────── 3. Calibration: human-scored only ─────────────────────────
alter table public.grade_summaries add column if not exists ai_final boolean not null default true;
comment on column public.grade_summaries.ai_final is
  'false when the latest calibration run marks the criterion human-scored only (docs/09 §8.3): the AI median is kept as evidence, final_score waits for human_score.';

-- Same as 0012, except that a human-only criterion takes no final score from the AI median.
create or replace function public.submission_summary_human_override()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.subject_type = 'submission' then
    new.final_score := coalesce(new.human_score, case when new.ai_final then new.median_score end);
    if new.human_score is not null then
      new.needs_human_review := false;
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.submission_summary_human_override() from public, anon, authenticated;

-- Applies a finished run's go-live statuses to submission grades already stored, for
-- applications still in play (no decided or closed ones): 'review' flags the criterion (the AI
-- score still counts), 'human_only' flags it and takes the AI score out of the final until a person
-- scores it, 'live' lets the AI score count again (flags stay until a person clears them).
-- Returns the applications whose scores changed (the caller refreshes their composites).
create or replace function public.apply_calibration_statuses(p_run_id uuid)
returns setof uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.calibration_runs%rowtype;
  crit text;
  st text;
  tag text;
  ids uuid[];
  touched uuid[] := '{}';
begin
  select * into r from public.calibration_runs where id = p_run_id and status = 'done';
  if not found then
    return;
  end if;
  for crit, st in select e.key, e.value ->> 'status' from jsonb_each(r.per_criterion) e loop
    if st is null or st not in ('live', 'review', 'human_only') then
      continue;
    end if;
    tag := 'calibration: ' || st;
    with targets as (
      select g.id, wa.application_id
      from public.grade_summaries g
      join public.rubrics rb on rb.id = g.rubric_id and rb.key = r.rubric_key
      join public.submissions s on s.id = g.subject_id and s.grading_status in ('done', 'needs_review')
      join public.work_attempts wa on wa.id = s.attempt_id
      join public.applications a on a.id = wa.application_id
      where g.subject_type = 'submission'
        and g.criterion_key = crit
        and a.status not in ('rejected', 'withdrawn', 'lapsed')
        and a.stage not in ('offer', 'closed')
        and (case st
               when 'live' then not g.ai_final
               when 'review' then not g.ai_final or (g.human_score is null and coalesce(g.review_reason, '') not like '%' || tag || '%')
               else g.ai_final or (g.human_score is null and coalesce(g.review_reason, '') not like '%' || tag || '%')
             end)
    ), upd as (
      update public.grade_summaries g
         set ai_final = (st <> 'human_only'),
             final_score = coalesce(g.human_score, case when st <> 'human_only' then g.median_score end),
             needs_human_review = case when st = 'live' then g.needs_human_review else g.human_score is null end,
             review_reason = case
               when st = 'live' or coalesce(g.review_reason, '') like '%' || tag || '%' then g.review_reason
               else concat_ws('; ', nullif(g.review_reason, ''), tag)
             end
        from targets t
       where g.id = t.id
      returning t.application_id
    )
    select coalesce(array_agg(upd.application_id), '{}') into ids from upd;
    touched := touched || ids;
  end loop;
  return query select distinct x from unnest(touched) x;
end;
$$;
revoke execute on function public.apply_calibration_statuses(uuid) from public, anon, authenticated;
grant execute on function public.apply_calibration_statuses(uuid) to service_role;

-- ───────────────────────── 4. Gold-set rater columns ─────────────────────────
alter table public.gold_samples add column if not exists human_raters jsonb not null default '{}';
comment on column public.gold_samples.human_raters is
  '{"1": admin user id, "2": admin user id}: who owns each human score column. One person scores one column.';

-- ───────────────────────── 5. Drift check ─────────────────────────
create table if not exists public.drift_blocks (
  rubric_key text not null,
  block int not null check (block >= 1),
  submission_ids uuid[] not null,         -- the 25 graded submissions in the block, frozen when it filled
  pick_ids uuid[] not null,               -- the 3 picked for a human re-score
  created_at timestamptz not null default now(),
  primary key (rubric_key, block)
);
alter table public.drift_blocks enable row level security;
drop policy if exists drift_blocks_admin_select on public.drift_blocks;
create policy drift_blocks_admin_select on public.drift_blocks for select to authenticated using (public.is_admin());
grant select on public.drift_blocks to authenticated;
-- Written by the service role only (after an admin check).

create table if not exists public.drift_rescores (
  id uuid primary key default gen_random_uuid(),
  rubric_key text not null,
  submission_id uuid not null references public.submissions (id) on delete cascade,
  criterion_key text not null,
  score int not null check (score between 1 and 5),
  rater uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (submission_id, criterion_key, rater)
);
create index if not exists drift_rescores_rubric_idx on public.drift_rescores (rubric_key, submission_id);
alter table public.drift_rescores enable row level security;
drop trigger if exists drift_rescores_updated_at on public.drift_rescores;
create trigger drift_rescores_updated_at before update on public.drift_rescores
  for each row execute function public.set_updated_at();
drop policy if exists drift_rescores_admin_select on public.drift_rescores;
create policy drift_rescores_admin_select on public.drift_rescores for select to authenticated using (public.is_admin());
drop policy if exists drift_rescores_admin_insert on public.drift_rescores;
create policy drift_rescores_admin_insert on public.drift_rescores for insert to authenticated
  with check (public.is_admin() and rater = auth.uid());
drop policy if exists drift_rescores_admin_update on public.drift_rescores;
create policy drift_rescores_admin_update on public.drift_rescores for update to authenticated
  using (public.is_admin() and rater = auth.uid()) with check (public.is_admin() and rater = auth.uid());
grant select on public.drift_rescores to authenticated;
grant insert (rubric_key, submission_id, criterion_key, score) on public.drift_rescores to authenticated;
grant update (score) on public.drift_rescores to authenticated;

notify pgrst, 'reload schema';
