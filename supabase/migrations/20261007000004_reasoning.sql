-- Reasoning Assessment: item templates, attempts and responses.
-- Items are parametric: a template row is (family, tier); each attempt renders fresh
-- instances from a seed and stores them, with their keys, in reasoning_responses.
-- Candidates never read templates or responses; items are served one at a time by the API.

create table public.reasoning_items (
  id uuid primary key default gen_random_uuid(),
  family text not null check (family in
    ('number_series', 'data_interp', 'deduction', 'letter_series', 'verbal', 'word_problem')),
  tier text not null check (tier in ('easy', 'medium', 'hard')),
  generator text not null,
  form text not null default 'online' check (form in ('online', 'live')),
  active boolean not null default true,
  version int not null default 1,
  exposures int not null default 0,
  difficulty_p numeric,      -- proportion correct, recomputed from responses
  discrimination numeric,    -- point-biserial, recomputed from responses
  created_at timestamptz not null default now(),
  unique (family, tier, form, version)
);
alter table public.reasoning_items enable row level security;
create policy reasoning_items_admin_select on public.reasoning_items
  for select to authenticated using (public.is_admin());
grant select on public.reasoning_items to authenticated;

insert into public.reasoning_items (family, tier, generator)
select f, t, f || '.v1'
from unnest(array['number_series', 'data_interp', 'deduction', 'letter_series', 'verbal', 'word_problem']) f
cross join unnest(array['easy', 'medium', 'hard']) t;

create table public.reasoning_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  form text not null default 'online' check (form in ('online', 'live')),
  seed bigint not null,
  item_count int not null default 30,
  started_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  submitted_at timestamptz,
  raw_score int check (raw_score between 0 and 30),
  percentile numeric check (percentile between 0 and 100),
  stars int check (stars between 1 and 6),
  norm_version text,
  created_at timestamptz not null default now(),
  check (deadline_at > started_at)
);
alter table public.reasoning_attempts enable row level security;
create index reasoning_attempts_user_idx on public.reasoning_attempts (user_id, started_at desc);

create policy reasoning_attempts_owner_select on public.reasoning_attempts
  for select to authenticated using (user_id = auth.uid());
create policy reasoning_attempts_admin_select on public.reasoning_attempts
  for select to authenticated using (public.is_admin());
-- Score fields only; the seed stays server-side.
grant select (id, user_id, form, item_count, started_at, deadline_at, submitted_at,
              raw_score, percentile, stars, norm_version)
  on public.reasoning_attempts to authenticated;

create view public.my_reasoning with (security_invoker = true) as
  select id, form, started_at, deadline_at, submitted_at, raw_score, percentile, stars, norm_version
  from public.reasoning_attempts
  where user_id = auth.uid();
grant select on public.my_reasoning to authenticated;

-- One online attempt per 90 days.
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
  if new.started_at <> old.started_at or new.deadline_at <> old.deadline_at
     or new.user_id <> old.user_id or new.seed <> old.seed then
    raise exception 'reasoning_attempt_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger reasoning_attempts_guard
  before insert or update on public.reasoning_attempts
  for each row execute function public.reasoning_attempt_guard();

create table public.reasoning_responses (
  attempt_id uuid not null references public.reasoning_attempts (id) on delete cascade,
  position int not null check (position between 1 and 30),
  item_id uuid not null references public.reasoning_items (id),
  family text not null,
  tier text not null,
  seed bigint not null,
  rendered jsonb not null,               -- {stem, options}; shown to the candidate when served
  answer_key int not null check (answer_key between 0 and 4),
  served_at timestamptz,
  answered_at timestamptz,               -- set by trigger; set with a null answer means skipped
  answer int check (answer between 0 and 4),
  correct boolean,
  primary key (attempt_id, position)
);
alter table public.reasoning_responses enable row level security;
create policy reasoning_responses_admin_select on public.reasoning_responses
  for select to authenticated using (public.is_admin());
grant select on public.reasoning_responses to authenticated;

-- Server-side timer + no back-navigation + server-side marking, enforced in the DB.
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

  if new.answered_at is not null then
    if old.served_at is null then
      raise exception 'reasoning_item_not_served' using errcode = 'P0001';
    end if;
    select deadline_at, submitted_at into a
    from public.reasoning_attempts where id = new.attempt_id;
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

create trigger reasoning_responses_guard
  before update on public.reasoning_responses
  for each row execute function public.reasoning_response_guard();
