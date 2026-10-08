-- Foundation: extensions, admin helper, default privilege posture.

create extension if not exists vector with schema extensions;

-- New tables in public must not be readable by anon (or anyone) until a migration grants it.
-- Adding RLS policies does not remove Supabase's default grants, so revoke them up front.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated, public;

create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;
grant execute on function public.is_admin() to authenticated;

create policy admins_admin_select on public.admins
  for select to authenticated using (public.is_admin());
grant select on public.admins to authenticated;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
