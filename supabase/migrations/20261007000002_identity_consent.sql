-- Profiles (one per auth user) and POPIA consents.

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  city text,
  province text,
  linkedin_url text,
  github_url text,
  portfolio_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create policy profiles_owner_select on public.profiles
  for select to authenticated using (user_id = auth.uid());
create policy profiles_admin_select on public.profiles
  for select to authenticated using (public.is_admin());
create policy profiles_owner_update on public.profiles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select on public.profiles to authenticated;
grant update (full_name, phone_e164, city, province, linkedin_url, github_url, portfolio_url)
  on public.profiles to authenticated;

-- Create the profile row when a user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, email) values (new.id, lower(new.email))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Consents are append-only. A change (e.g. talent pool opt-in) is a new row.
create table public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  notice_version text not null,
  accepted_processing boolean not null,
  accepted_ai_assessment boolean not null,
  accepted_offshore_processing boolean not null,
  talent_pool_opt_in boolean not null default false,
  accepted_at timestamptz not null default now(),
  ip inet,
  user_agent text,
  -- The three core consents are required to take part; declining simply means no row.
  check (accepted_processing and accepted_ai_assessment and accepted_offshore_processing)
);
alter table public.consents enable row level security;
create index consents_user_idx on public.consents (user_id, accepted_at desc);

create policy consents_owner_insert on public.consents
  for insert to authenticated with check (user_id = auth.uid());
create policy consents_owner_select on public.consents
  for select to authenticated using (user_id = auth.uid());
create policy consents_admin_select on public.consents
  for select to authenticated using (public.is_admin());

grant select on public.consents to authenticated;
-- user_id comes from the auth.uid() default and accepted_at from now(); clients can't set either.
grant insert (notice_version, accepted_processing, accepted_ai_assessment,
              accepted_offshore_processing, talent_pool_opt_in, ip, user_agent)
  on public.consents to authenticated;
