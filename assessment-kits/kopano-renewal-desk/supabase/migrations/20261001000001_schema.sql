-- Renewal Desk schema: one customer record, accounts, lines, contact points with consent,
-- allocations, interactions, the legal opt-out list, message templates and the message queue,
-- plus the import log and its quarantine report.

create extension if not exists fuzzystrmatch with schema extensions;

-- People who use the Desk. One row per auth user.
create table public.agents (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  email text,
  role text not null default 'agent' check (role in ('agent', 'manager', 'admin')),
  created_at timestamptz not null default now()
);

-- One row per company. Identity: registration number when known, else the normalised name.
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  normalised_name text not null,
  reg_no text unique,
  segment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customers_normalised_name_idx on public.customers (normalised_name);

-- Billing accounts. One customer can hold several.
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id),
  account_no text not null unique,
  dealer_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index accounts_customer_idx on public.accounts (customer_id);

-- Price-plan rules that change when a line may be renewed.
create table public.priceplan_rules (
  code text primary key,
  name text,
  last_month_only boolean not null default false
);

-- Phone lines (the grain of the monthly export).
create table public.lines (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  msisdn_e164 text not null unique check (msisdn_e164 ~ '^\+27[0-9]{9}$'),
  number_type text not null check (number_type in ('mobile', 'landline')),
  priceplan text,
  priceplan_name text,
  term_months integer,
  contract_end_date date,
  contract_status text not null default 'Unknown' check (contract_status in ('InContract', 'Out Of Contract', 'Unknown')),
  device text,
  monthly_charge_zar numeric(12, 2),
  active boolean not null default true,
  ported_out_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index lines_account_idx on public.lines (account_id);
create index lines_end_date_idx on public.lines (contract_end_date) where active;

-- Ways to reach a customer, each with its own consent status.
create table public.contact_points (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id),
  type text not null check (type in ('mobile', 'landline', 'email', 'whatsapp')),
  value text not null,
  person_name text,
  role text not null default 'unknown' check (role in ('decision_maker', 'admin', 'unknown')),
  consent_status text not null default 'unknown' check (consent_status in ('opted_in', 'existing_customer_s69_3', 'opted_out', 'unknown')),
  verified_at timestamptz,
  source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, type, value)
);

-- Which agent works which customer (one agent per customer).
create table public.allocations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null unique references public.customers (id),
  agent_id uuid not null references public.agents (id),
  allocated_by uuid references public.agents (id),
  allocated_at timestamptz not null default now()
);
create index allocations_agent_idx on public.allocations (agent_id);

-- Call outcomes. Append-only history.
create table public.interactions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id),
  agent_id uuid not null default auth.uid() references public.agents (id),
  outcome text not null check (outcome in ('call_back', 'quote', 'sale', 'not_interested', 'no_answer')),
  next_action_at timestamptz,
  notes text check (char_length(notes) <= 2000),
  created_at timestamptz not null default now()
);
create index interactions_customer_idx on public.interactions (customer_id, created_at desc);

-- RD-07: a call back is only valid with a callback date in the future.
alter table public.interactions
  add constraint interactions_call_back_needs_date
  check (outcome <> 'call_back' or (next_action_at is not null and next_action_at > created_at));

-- Legal's opt-out and "under legal review" list. It names companies, not accounts.
create table public.optouts (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,
  normalised_name text not null unique,
  status text not null default 'opted_out' check (status in ('opted_out', 'legal_review')),
  customer_id uuid references public.customers (id),
  match_method text check (match_method in ('exact', 'fuzzy', 'manual')),
  match_distance integer,
  reason text,
  logged_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index optouts_customer_idx on public.optouts (customer_id);

-- Network-approved message templates.
create table public.templates (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  category text not null check (category in ('utility', 'marketing')),
  body text not null,
  approved boolean not null default false,
  created_at timestamptz not null default now()
);

-- Messages waiting to be sent by the messaging platform (nothing is sent from the Desk).
create table public.message_queue (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id),
  template_id uuid not null references public.templates (id),
  contact_point_id uuid references public.contact_points (id),
  channel text check (channel in ('sms', 'whatsapp', 'email')),
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'cancelled')),
  created_by uuid not null default auth.uid() references public.agents (id),
  created_at timestamptz not null default now()
);
create index message_queue_customer_idx on public.message_queue (customer_id);

-- Every import attempt, successful or not.
create table public.import_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'base' check (kind in ('base', 'contacts', 'optouts')),
  file_name text not null,
  file_sha256 text,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  counts jsonb not null default '{}'::jsonb,
  error text,
  created_by uuid references public.agents (id),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- Rows an import could not trust, with the reason, for the manager to fix at source.
create table public.quarantine_rows (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null references public.import_runs (id) on delete cascade,
  row_number integer not null,
  reason text not null,
  detail text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index quarantine_rows_run_idx on public.quarantine_rows (import_run_id, row_number);
