-- SWE Test 1 verification harness: a log of harness runs per submission (URL checks, month-2
-- import checks, repo checks dispatched to GitHub Actions). It shows the admin what is running
-- and when the last run happened, and it is a lock: at most one run of each kind per submission
-- at a time, so a double click cannot start two month-2 imports against a candidate's database.
-- Results themselves stay in verification_runs (migration 0011).
--
-- Re-runnable: safe to apply more than once (psql -v ON_ERROR_STOP=1 -1 -f).

create table if not exists public.harness_runs (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions (id) on delete cascade,
  kind text not null check (kind in ('url', 'import', 'repo')),
  status text not null default 'running' check (status in ('running', 'done', 'failed', 'dispatched')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ran_by uuid references auth.users (id) on delete set null,
  summary jsonb not null default '{}'
);

alter table public.harness_runs enable row level security;

create index if not exists harness_runs_submission_idx on public.harness_runs (submission_id, kind, started_at desc);
-- The lock: one running run per (submission, kind). Stale rows are closed by the server first.
create unique index if not exists harness_runs_one_running on public.harness_runs (submission_id, kind) where status = 'running';

-- Admins read; only the server (service role) writes.
drop policy if exists harness_runs_admin_select on public.harness_runs;
create policy harness_runs_admin_select on public.harness_runs for select to authenticated using (public.is_admin());
revoke all on public.harness_runs from anon, authenticated;
grant select on public.harness_runs to authenticated;
