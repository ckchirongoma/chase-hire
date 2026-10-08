-- Live stage and grader calibration: review fixes (docs/09 §5 and §8).
--
-- 1. Independent raters: once a panellist has submitted a part they see the other panellists'
--    SUBMITTED cards for it, never their drafts.
-- 2. Scorecard guard: cards only while the application is at shortlist/live; a scored card holds
--    integer scores 1-5 for its own questions (question_keys) and, on submit, every question of the
--    role's bank for that part, with the total computed here (mean 1-5 mapped onto 0-100, as
--    lib/scoring rubricTo100) whatever the client sent; a draft has no total. A reasoning retest is
--    recorded once, never as a draft, and its percentiles and delta are derived here from the raw
--    score (live_retest_percentile); recording it sets applications.live_delta. 'portfolio' has no
--    scorecard and is refused.
-- 3. Calibration 'human_only' (docs/09 §8.3, "human-scored only until fixed"): grade_summaries.ai_final
--    false keeps the AI median as evidence but leaves final_score empty until a person scores it.
--    apply_calibration_statuses(run) applies a finished run's statuses to grades already stored.
-- 4. Gold-set human scores (docs/09 §8.1, two people score independently): which admin owns rater
--    column 1 and 2 (human_raters), claimed atomically by save_gold_human_scores, the only write
--    path for human_scores.
-- 5. Drift check (docs/09 §8.4): frozen blocks of 25 with their 3 picks, and drift re-scores kept
--    apart from review overrides (they never change a candidate's score).
--
-- Re-runnable.

-- ───────────────────────── 1. Draft visibility ─────────────────────────
drop policy if exists live_scorecards_select on public.live_scorecards;
create policy live_scorecards_select on public.live_scorecards for select to authenticated using (
  public.is_admin()
  and (rater = auth.uid()
       or (submitted_at is not null and public.has_submitted_scorecard(application_id, kind))));

-- ───────────────────────── 2. Scorecard guard ─────────────────────────
-- The questions a card was scored against (bank keys, plus concern_<hash> keys for the panel
-- interview's verification slots). Written by the server action; checked on submit.
alter table public.live_scorecards add column if not exists question_keys text[];
grant insert (question_keys) on public.live_scorecards to authenticated;
grant update (question_keys) on public.live_scorecards to authenticated;

-- Live retest norm (lib/live/retest.ts LIVE_NORM, 'live-provisional-normal-v1': normal 5.4 ± 2.374
-- on 12 items, equated to the online applicant pool): raw 0..12 → live percentile. A unit test keeps
-- this table and the TypeScript norm identical (tests/unit/live/retest-sql.test.ts).
create or replace function public.live_retest_percentile(p_raw int)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select (array[1.1, 3.2, 7.6, 15.6, 27.8, 43.3, 60, 75, 86.3, 93.5, 97.4, 99.1, 99.7]::numeric[])[p_raw + 1]
  where p_raw between 0 and 12;
$$;
revoke execute on function public.live_retest_percentile(int) from public, anon;
grant execute on function public.live_retest_percentile(int) to authenticated, service_role;

-- SECURITY DEFINER so the checks see the application, the bank and every panellist's retest row
-- (RLS hides them). Whatever the client sends:
--   * cards are written only while the application is at the shortlist or live stage;
--   * a scored card (panel / defence / elicitation / exec) holds integer scores 1-5 for its own
--     questions only; on submit it must score every question of the role's bank for that part
--     (the panel's two verification slots may be concern_<hash> keys), and the database computes
--     the total (mean 1-5 mapped onto 0-100, as lib/scoring rubricTo100); a draft has no total;
--   * a reasoning retest is recorded once per application, submitted (never a draft), and its
--     live percentile, online percentile and delta are derived here from the raw score;
--   * 'portfolio' has no scorecard yet and is refused.
create or replace function public.live_scorecard_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage text;
  v_role text;
  v_user uuid;
  k text;
  v jsonb;
  valid boolean;
  n int := 0;
  s numeric := 0;
  bank_n int;
  concern_n int := 0;
  raw numeric;
  seed numeric;
  pct numeric;
  online numeric;
begin
  if tg_op = 'UPDATE' and old.submitted_at is not null then
    raise exception 'scorecard_already_submitted' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and (new.application_id, new.kind, new.rater) is distinct from (old.application_id, old.kind, old.rater) then
    raise exception 'scorecard_identity_fixed' using errcode = 'P0001';
  end if;

  select a.stage, r.slug, a.user_id into v_stage, v_role, v_user
    from public.applications a
    join public.roles r on r.id = a.role_id
   where a.id = new.application_id;
  if v_stage is null or v_stage not in ('shortlist', 'live') then
    raise exception 'application_not_at_live_stage' using errcode = 'P0001';
  end if;

  if new.submitted_at is not null then
    new.submitted_at := now();
  end if;

  if new.kind = 'portfolio' then
    raise exception 'scorecard_kind_unsupported' using errcode = '22023';
  end if;

  -- ── Reasoning retest: one per application, final on entry, derived from the raw score ──
  if new.kind = 'reasoning_retest' then
    if new.submitted_at is null then
      raise exception 'retest_must_be_submitted' using errcode = '22023';
    end if;
    if jsonb_typeof(new.scores -> 'raw') is distinct from 'number' then
      raise exception 'retest_raw_invalid' using errcode = '22023';
    end if;
    raw := (new.scores ->> 'raw')::numeric;
    if raw <> trunc(raw) or raw < 0 or raw > 12 then
      raise exception 'retest_raw_invalid' using errcode = '22023';
    end if;
    if jsonb_typeof(new.scores -> 'seed') is distinct from 'number' then
      raise exception 'retest_seed_invalid' using errcode = '22023';
    end if;
    seed := (new.scores ->> 'seed')::numeric;
    if seed <> trunc(seed) or seed < 1 or seed > 2147483647 then
      raise exception 'retest_seed_invalid' using errcode = '22023';
    end if;
    if tg_op = 'INSERT' then
      perform pg_advisory_xact_lock(hashtextextended('live_retest:' || new.application_id::text, 0));
      if exists (select 1 from public.live_scorecards x where x.application_id = new.application_id and x.kind = 'reasoning_retest') then
        raise exception 'retest_already_recorded' using errcode = 'P0001';
      end if;
    end if;
    pct := public.live_retest_percentile(raw::int);
    -- The candidate's latest submitted ONLINE attempt (the one the composite uses).
    select ra.percentile into online
      from public.reasoning_attempts ra
     where ra.user_id = v_user and ra.form = 'online' and ra.submitted_at is not null
     order by ra.started_at desc
     limit 1;
    new.total := pct;
    new.question_keys := null;
    new.scores := jsonb_build_object(
      'raw', raw::int,
      'seed', seed::bigint,
      'norm_version', 'live-provisional-normal-v1',
      'live_percentile', pct,
      'online_percentile', online,
      'delta', case when online is null then null else round(online - pct, 1) end);
    return new;
  end if;

  -- ── Scored cards ──
  select count(*) into bank_n
    from public.live_questions q
   where q.role_slug = v_role and q.kind = new.kind and q.active;
  if bank_n = 0 then
    raise exception 'scorecard_kind_not_for_role' using errcode = '22023';
  end if;
  if new.kind = 'panel_interview' then
    bank_n := least(bank_n, 6);
  end if;

  if jsonb_typeof(new.scores) is distinct from 'object' then
    raise exception 'scorecard_scores_invalid' using errcode = '22023';
  end if;
  for k, v in select e.key, e.value from jsonb_each(new.scores) e loop
    valid := case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric in (1, 2, 3, 4, 5) else false end;
    if not valid or (new.question_keys is not null and not (k = any (new.question_keys))) then
      raise exception 'scorecard_scores_invalid' using errcode = '22023';
    end if;
    n := n + 1;
    s := s + (v #>> '{}')::numeric;
  end loop;

  if new.submitted_at is null then
    new.total := null;
    return new;
  end if;

  -- On submit: the card's questions are the role's bank for this part (verification slots aside),
  -- and every one of them has a score.
  if new.question_keys is null or cardinality(new.question_keys) <> bank_n
     or (select count(distinct x) from unnest(new.question_keys) x) <> bank_n then
    raise exception 'scorecard_questions_mismatch' using errcode = '22023';
  end if;
  foreach k in array new.question_keys loop
    if k ~ '^concern_[0-9a-f]{8}(_[0-9])?$' then
      if new.kind <> 'panel_interview' then
        raise exception 'scorecard_questions_mismatch' using errcode = '22023';
      end if;
      concern_n := concern_n + 1;
    elsif not exists (
      select 1 from public.live_questions q
       where q.role_slug = v_role and q.kind = new.kind and q.key = k and q.active) then
      raise exception 'scorecard_questions_mismatch' using errcode = '22023';
    end if;
  end loop;
  if concern_n > 2 then
    raise exception 'scorecard_questions_mismatch' using errcode = '22023';
  end if;
  if n <> bank_n then
    raise exception 'scorecard_scores_missing' using errcode = '22023';
  end if;
  new.total := round(((s / n) - 1) / 4 * 100, 1);
  return new;
end;
$$;
revoke execute on function public.live_scorecard_guard() from public, anon, authenticated;

-- A recorded retest sets applications.live_delta (applications has no admin UPDATE policy; the
-- trigger writes it whichever way the row arrived). The live_delta signal for discussion is logged
-- by the server action.
create or replace function public.live_retest_recorded()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.applications
     set live_delta = nullif(new.scores ->> 'delta', '')::numeric
   where id = new.application_id;
  return new;
end;
$$;
revoke execute on function public.live_retest_recorded() from public, anon, authenticated;
drop trigger if exists live_scorecards_retest_recorded on public.live_scorecards;
create trigger live_scorecards_retest_recorded after insert on public.live_scorecards
  for each row when (new.kind = 'reasoning_retest') execute function public.live_retest_recorded();

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
      join public.rubrics rb on rb.id = g.rubric_id and rb.key = r.rubric_key and (r.rubric_id is null or rb.id = r.rubric_id)
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

-- Human scores are written only through save_gold_human_scores (docs/09 §8.1: two people score
-- independently): admins keep writing the label and text directly.
revoke insert, update on public.gold_samples from authenticated;
grant insert (rubric_key, label, file_path, text_content, created_by) on public.gold_samples to authenticated;
grant update (label, text_content, file_path) on public.gold_samples to authenticated;

-- Saves one rater's column. The first save claims the column for the caller (atomically, under a
-- row lock); a column another admin owns is refused, and so is a second column for the same admin.
-- p_scores: {criterion_key: 1..5 | null}; null clears that criterion in the caller's column only.
create or replace function public.save_gold_human_scores(p_gold_id uuid, p_rater int, p_scores jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  g public.gold_samples%rowtype;
  owner_id text;
  other_id text;
  hs jsonb;
  pair jsonb;
  k text;
  v jsonb;
begin
  if me is null or not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  if p_rater is null or p_rater not in (1, 2) then
    raise exception 'gold_rater_invalid' using errcode = '22023';
  end if;
  if jsonb_typeof(p_scores) is distinct from 'object' then
    raise exception 'gold_scores_invalid' using errcode = '22023';
  end if;
  select * into g from public.gold_samples where id = p_gold_id for update;
  if not found then
    raise exception 'gold_not_found' using errcode = 'P0002';
  end if;
  owner_id := g.human_raters ->> p_rater::text;
  other_id := g.human_raters ->> (3 - p_rater)::text;
  if owner_id is not null and owner_id <> me::text then
    raise exception 'gold_column_taken' using errcode = 'P0001';
  end if;
  if other_id = me::text then
    raise exception 'gold_one_column_per_rater' using errcode = 'P0001';
  end if;

  hs := case when jsonb_typeof(g.human_scores) = 'object' then g.human_scores else '{}'::jsonb end;
  for k, v in select e.key, e.value from jsonb_each(p_scores) e loop
    if k !~ '^[a-z0-9_]+(\.[a-z0-9_]+)?$'
       or not (jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric in (1, 2, 3, 4, 5))) then
      raise exception 'gold_scores_invalid' using errcode = '22023';
    end if;
    pair := hs -> k;
    if jsonb_typeof(pair) is distinct from 'array' or jsonb_array_length(pair) <> 2 then
      pair := '[null, null]'::jsonb;
    end if;
    pair := jsonb_set(pair, array[(p_rater - 1)::text], v);
    if pair = '[null, null]'::jsonb then
      hs := hs - k;
    else
      hs := jsonb_set(hs, array[k], pair, true);
    end if;
  end loop;

  update public.gold_samples
     set human_scores = hs,
         human_raters = case when owner_id is null
                             then coalesce(g.human_raters, '{}'::jsonb) || jsonb_build_object(p_rater::text, me::text)
                             else g.human_raters end
   where id = p_gold_id;
end;
$$;
revoke execute on function public.save_gold_human_scores(uuid, int, jsonb) from public, anon;
grant execute on function public.save_gold_human_scores(uuid, int, jsonb) to authenticated;

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
drop policy if exists drift_rescores_admin_delete on public.drift_rescores;
create policy drift_rescores_admin_delete on public.drift_rescores for delete to authenticated
  using (public.is_admin() and rater = auth.uid());
grant select, delete on public.drift_rescores to authenticated;
grant insert (rubric_key, submission_id, criterion_key, score) on public.drift_rescores to authenticated;
grant update (score) on public.drift_rescores to authenticated;

notify pgrst, 'reload schema';
