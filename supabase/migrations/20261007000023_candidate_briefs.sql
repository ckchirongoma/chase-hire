-- Candidate briefs: an AI-written, internal summary of a candidate for admins ("tell me about
-- this person"), with an advisory recommendation per application. Advisory only: nothing here
-- changes an application, and every decision stays an admin_decide() with a written reason.
-- Rebuilt when the inputs change (inputs_hash). Deleted with the user (retention purge deletes
-- the auth user; the cascade removes the brief).

create table public.candidate_briefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  content jsonb not null,
  inputs_hash text not null,
  model text not null,
  prompt_version text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.candidate_briefs enable row level security;
create policy candidate_briefs_admin_select on public.candidate_briefs
  for select to authenticated using (public.is_admin());
grant select on public.candidate_briefs to authenticated;
-- Written by the server (service role) after an admin check; candidates never see briefs.
