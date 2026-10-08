-- Business rules enforced by the database: contract status, renewal eligibility, opt-outs and
-- consent for messaging, plus the views the queue and exceptions pages read.

-- ───────────── Contract status ─────────────

create or replace function public.derive_contract_status(p_end date)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_end is null then 'Unknown'
    when p_end >= current_date then 'InContract'
    else 'Out Of Contract'
  end;
$$;

-- Contract status comes from the end date, never from the export's status column.
create or replace function public.lines_set_contract_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.contract_status := public.derive_contract_status(new.contract_end_date);
  return new;
end;
$$;

create trigger lines_set_contract_status
  before insert or update of contract_end_date, contract_status on public.lines
  for each row execute function public.lines_set_contract_status();

-- Re-derives statuses that went stale as days passed (called by every base import).
create or replace function public.refresh_contract_status()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.lines
     set contract_status = public.derive_contract_status(contract_end_date)
   where contract_status is distinct from public.derive_contract_status(contract_end_date);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function public.refresh_contract_status() from public, anon;
grant execute on function public.refresh_contract_status() to service_role;

-- ───────────── Opt-outs and consent (RD-11) ─────────────

-- True when the customer is on Legal's list (opted out or under legal review), whether the list
-- entry was matched to the customer or only shares its normalised name.
create or replace function public.customer_opted_out(p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.optouts o
    where o.customer_id = p_customer_id
       or o.normalised_name = (select c.normalised_name from public.customers c where c.id = p_customer_id)
  );
$$;
revoke execute on function public.customer_opted_out(uuid) from public, anon;
grant execute on function public.customer_opted_out(uuid) to authenticated, service_role;

-- Checks every queued message, however it was inserted (app route, REST, SQL).
create or replace function public.message_queue_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template public.templates%rowtype;
  v_contact_id uuid;
  v_channel text;
begin
  if public.customer_opted_out(new.customer_id) then
    raise exception 'This customer is on the opt-out list, so no message can be queued.'
      using errcode = 'P0001', hint = 'opted_out';
  end if;

  select * into v_template from public.templates t where t.id = new.template_id;
  if not found or not v_template.approved then
    raise exception 'Only approved templates can be used.' using errcode = 'P0001', hint = 'template_not_approved';
  end if;

  -- Utility messages may use the existing-customer basis; marketing needs an explicit opt-in.
  select cp.id,
         case cp.type when 'email' then 'email' when 'whatsapp' then 'whatsapp' else 'sms' end
    into v_contact_id, v_channel
    from public.contact_points cp
   where cp.customer_id = new.customer_id
     and cp.type in ('mobile', 'whatsapp', 'email')
     and (new.contact_point_id is null or cp.id = new.contact_point_id)
     and (cp.consent_status = 'opted_in'
          or (v_template.category = 'utility' and cp.consent_status = 'existing_customer_s69_3'))
   order by (cp.consent_status = 'opted_in') desc, (cp.type = 'whatsapp') desc, (cp.type = 'mobile') desc,
            cp.verified_at desc nulls last, cp.created_at
   limit 1;
  if v_contact_id is null then
    raise exception 'This customer has no contact point with consent for this template.'
      using errcode = 'P0001', hint = 'no_consented_contact';
  end if;

  new.contact_point_id := v_contact_id;
  new.channel := v_channel;
  new.status := 'queued';
  new.created_at := now();
  return new;
end;
$$;

create trigger message_queue_guard
  before insert on public.message_queue
  for each row execute function public.message_queue_guard();

-- ───────────── Renewal queue ─────────────

-- Active lines whose contract ends in the next 90 days, with the date each may be renewed from:
-- 90 days before the end date, or 30 days for plans that only upgrade in the last month.
create or replace view public.renewal_lines
with (security_invoker = true)
as
select
  l.id as line_id,
  a.customer_id,
  a.account_no,
  l.msisdn_e164,
  l.number_type,
  l.priceplan,
  l.priceplan_name,
  l.contract_end_date,
  l.monthly_charge_zar,
  coalesce(r.last_month_only, false) as last_month_only,
  l.contract_end_date - (case when coalesce(r.last_month_only, false) then 30 else 90 end) as eligible_from,
  l.contract_end_date - current_date as days_to_end
from public.lines l
join public.accounts a on a.id = l.account_id
left join public.priceplan_rules r on r.code = l.priceplan
where l.active
  and l.contract_end_date between current_date and current_date + 90;

-- The latest interaction per customer.
create or replace view public.latest_interactions
with (security_invoker = true)
as
select distinct on (i.customer_id)
  i.customer_id,
  i.id as interaction_id,
  i.agent_id,
  i.outcome,
  i.next_action_at,
  i.created_at
from public.interactions i
order by i.customer_id, i.created_at desc;

-- One row per customer with lines in the window.
create or replace view public.renewal_queue
with (security_invoker = true)
as
select
  c.id as customer_id,
  c.legal_name,
  c.segment,
  count(*)::integer as lines_in_window,
  min(rl.contract_end_date) as first_end_date,
  min(rl.eligible_from) as first_eligible_from,
  bool_or(rl.eligible_from <= current_date) as eligible_now,
  coalesce(sum(rl.monthly_charge_zar), 0)::numeric(12, 2) as monthly_charges_zar,
  al.agent_id,
  li.outcome as last_outcome,
  li.next_action_at,
  li.created_at as last_contact_at,
  public.customer_opted_out(c.id) as opted_out,
  exists (
    select 1 from public.contact_points cp
    where cp.customer_id = c.id
      and cp.type in ('mobile', 'whatsapp', 'email')
      and cp.consent_status in ('opted_in', 'existing_customer_s69_3')
  ) as contactable,
  exists (
    select 1 from public.contact_points cp
    where cp.customer_id = c.id and cp.consent_status <> 'opted_out'
  ) as has_contact
from public.renewal_lines rl
join public.customers c on c.id = rl.customer_id
left join public.allocations al on al.customer_id = c.id
left join public.latest_interactions li on li.customer_id = c.id
group by c.id, c.legal_name, c.segment, al.agent_id, li.outcome, li.next_action_at, li.created_at;

grant select on public.renewal_lines, public.latest_interactions, public.renewal_queue to authenticated;
revoke all on public.renewal_lines, public.latest_interactions, public.renewal_queue from anon;

-- ───────────── Health ─────────────

create or replace function public.health_check()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('db', 'ok', 'time', now(), 'templates', (select count(*) from public.templates));
$$;
revoke execute on function public.health_check() from public;
grant execute on function public.health_check() to anon, authenticated, service_role;
