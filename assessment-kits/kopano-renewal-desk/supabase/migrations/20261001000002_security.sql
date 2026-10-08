-- Access control. Agents see only the customers allocated to them; managers and admins see
-- everything; anonymous visitors see nothing. Writes that need several tables at once (the
-- imports) go through SECURITY DEFINER functions that check the caller's role themselves.

-- ───────────── Helpers (SECURITY DEFINER so policies can call them without recursion) ─────────────

create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select a.role from public.agents a where a.id = auth.uid();
$$;

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select a.role in ('manager', 'admin') from public.agents a where a.id = auth.uid()), false);
$$;

create or replace function public.is_allocated(p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.allocations al where al.customer_id = p_customer_id and al.agent_id = auth.uid()
  );
$$;

create or replace function public.can_see_customer(p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_manager() or public.is_allocated(p_customer_id);
$$;

create or replace function public.can_see_account(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_manager() or exists (
    select 1
    from public.accounts a
    join public.allocations al on al.customer_id = a.customer_id
    where a.id = p_account_id and al.agent_id = auth.uid()
  );
$$;

revoke execute on function public.my_role() from public, anon;
revoke execute on function public.is_manager() from public, anon;
revoke execute on function public.is_allocated(uuid) from public, anon;
revoke execute on function public.can_see_customer(uuid) from public, anon;
revoke execute on function public.can_see_account(uuid) from public, anon;
grant execute on function public.my_role() to authenticated, service_role;
grant execute on function public.is_manager() to authenticated, service_role;
grant execute on function public.is_allocated(uuid) to authenticated, service_role;
grant execute on function public.can_see_customer(uuid) to authenticated, service_role;
grant execute on function public.can_see_account(uuid) to authenticated, service_role;

-- ───────────── Row level security on every table ─────────────

alter table public.agents enable row level security;
alter table public.customers enable row level security;
alter table public.accounts enable row level security;
alter table public.priceplan_rules enable row level security;
alter table public.lines enable row level security;
alter table public.contact_points enable row level security;
alter table public.allocations enable row level security;
alter table public.interactions enable row level security;
alter table public.optouts enable row level security;
alter table public.templates enable row level security;
alter table public.message_queue enable row level security;
alter table public.import_runs enable row level security;
alter table public.quarantine_rows enable row level security;

-- agents: yourself; managers see the team.
create policy agents_select on public.agents for select to authenticated
  using (id = auth.uid() or public.is_manager());

-- customers, accounts, lines: allocated customers only (managers: all). Written only by the import.
create policy customers_select on public.customers for select to authenticated
  using (public.can_see_customer(id));

create policy accounts_select on public.accounts for select to authenticated
  using (public.can_see_customer(customer_id));

create policy lines_select on public.lines for select to authenticated
  using (public.can_see_account(account_id));

create policy priceplan_rules_select on public.priceplan_rules for select to authenticated
  using (true);
create policy priceplan_rules_manage on public.priceplan_rules for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

-- contact points: read and capture for your own customers.
create policy contact_points_select on public.contact_points for select to authenticated
  using (public.can_see_customer(customer_id));
create policy contact_points_insert on public.contact_points for insert to authenticated
  with check (public.can_see_customer(customer_id));
create policy contact_points_update on public.contact_points for update to authenticated
  using (public.can_see_customer(customer_id)) with check (public.can_see_customer(customer_id));

-- allocations: your own; managers allocate.
create policy allocations_select on public.allocations for select to authenticated
  using (agent_id = auth.uid() or public.is_manager());
create policy allocations_manage on public.allocations for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

-- interactions: history of your own customers; you can only log as yourself.
create policy interactions_select on public.interactions for select to authenticated
  using (public.can_see_customer(customer_id));
create policy interactions_insert on public.interactions for insert to authenticated
  with check (agent_id = auth.uid() and public.can_see_customer(customer_id));

-- opt-outs: managers maintain the list; agents see the entries for their customers.
create policy optouts_select on public.optouts for select to authenticated
  using (public.is_manager() or (customer_id is not null and public.is_allocated(customer_id)));
create policy optouts_manage on public.optouts for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

-- templates: everyone signed in reads; managers maintain.
create policy templates_select on public.templates for select to authenticated
  using (true);
create policy templates_manage on public.templates for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

-- message queue: your own customers; queued as yourself (the RD-11 trigger checks the rest).
create policy message_queue_select on public.message_queue for select to authenticated
  using (public.can_see_customer(customer_id));
create policy message_queue_insert on public.message_queue for insert to authenticated
  with check (created_by = auth.uid() and public.can_see_customer(customer_id));

-- imports: managers only.
create policy import_runs_select on public.import_runs for select to authenticated
  using (public.is_manager());
create policy quarantine_rows_select on public.quarantine_rows for select to authenticated
  using (public.is_manager());

-- ───────────── Grants ─────────────

-- Nothing is readable or writable without signing in.
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
