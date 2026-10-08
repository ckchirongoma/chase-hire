-- Hardening after the first security review: rules that the screens enforced but the database
-- did not, statuses that went stale between imports, and functions or reference tables that any
-- signed-in account could reach. Each block below says which story or rule it protects.

-- ───────────── Contract status stays current between imports (BR-E3) ─────────────

-- The stored status is derived when a line is written and on every import, but a date passes at
-- midnight without anything being written. Refresh it every hour, on the hour: the change lands at
-- 00:00 UTC, and a missed run is caught up within the hour. The app also derives the status from
-- the end date whenever it shows a line, so a screen is never stale.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('refresh-contract-status', '0 * * * *', 'select public.refresh_contract_status()');
  else
    raise notice 'pg_cron is not available: contract statuses are refreshed by each import only';
  end if;
end;
$$;

-- Bring any status that went stale before this migration up to date now.
select public.refresh_contract_status();

-- Only the database itself (imports, the hourly job) and the server key may run the refresh.
revoke execute on function public.refresh_contract_status() from public, anon, authenticated;

-- ───────────── Call history cannot be backdated (RD-06, RD-07) ─────────────

-- Signed-in users log outcomes now, as themselves: a forged created_at or agent_id from a REST
-- client is replaced. That also makes the callback-date check constraint mean "in the future",
-- since it compares next_action_at with created_at. Only the server key (seed, scripts) may record
-- another time or agent, e.g. when loading old history.
create or replace function public.interactions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    new.created_at := now();
    new.agent_id := auth.uid();
  end if;
  return new;
end;
$$;

create trigger interactions_guard
  before insert on public.interactions
  for each row execute function public.interactions_guard();

-- ───────────── Contact points: consent the screen cannot be trusted with (RD-05, BR-C5) ─────────────

-- Who changed the consent last, when, and (when a manager lifts an opt-out) why.
alter table public.contact_points
  add column consent_changed_at timestamptz,
  add column consent_changed_by uuid references public.agents (id),
  add column consent_note text check (char_length(consent_note) <= 500);

create or replace function public.contact_points_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- No signed-in user: the server key (seed, scripts) or SQL run by an administrator.
  v_system boolean := auth.uid() is null;
begin
  -- BR-C5: a phone number is E.164 text, and its type follows from the number. Landlines
  -- (+27 1x to 5x) can be recorded but never as a mobile or WhatsApp number, so never messaged.
  if new.type in ('mobile', 'landline', 'whatsapp') then
    if new.value !~ '^\+27[0-9]{9}$' then
      raise exception '"%" is not a South African number in E.164 (+27XXXXXXXXX).', new.value
        using errcode = '23514', hint = 'phone_format';
    end if;
    if new.value ~ '^\+27[1-5]' and new.type <> 'landline' then
      raise exception '% is a landline: record it as a landline (landlines are never messaged).', new.value
        using errcode = '23514', hint = 'landline';
    end if;
    if new.value !~ '^\+27[1-5]' and new.type = 'landline' then
      raise exception '% is a mobile number, not a landline.', new.value
        using errcode = '23514', hint = 'not_landline';
    end if;
  end if;

  if tg_op = 'INSERT' then
    -- RD-05: an opt-out follows the number or address. A new contact point for a value this
    -- customer has opted out on starts opted out.
    if exists (
      select 1 from public.contact_points o
      where o.customer_id = new.customer_id and o.value = new.value and o.consent_status = 'opted_out'
    ) then
      new.consent_status := 'opted_out';
    end if;
    new.consent_changed_at := now();
    new.consent_changed_by := auth.uid();
    return new;
  end if;

  -- UPDATE: the note belongs to a consent change; it is not edited on its own.
  if new.consent_status is not distinct from old.consent_status then
    new.consent_note := old.consent_note;
    return new;
  end if;
  if new.consent_note is not distinct from old.consent_note then
    new.consent_note := null;
  end if;

  -- RD-05: once a contact point is opted out, only a manager can lift it, with a reason.
  if old.consent_status = 'opted_out' and not v_system then
    if not public.is_manager() then
      raise exception 'This contact opted out. Only a manager can lift an opt-out.'
        using errcode = '42501', hint = 'opt_out_locked';
    end if;
    if coalesce(char_length(btrim(new.consent_note)), 0) < 5 then
      raise exception 'Give the reason for lifting this opt-out (at least 5 characters).'
        using errcode = '23514', hint = 'reason_required';
    end if;
  end if;

  new.consent_changed_at := now();
  new.consent_changed_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create trigger contact_points_guard
  before insert or update on public.contact_points
  for each row execute function public.contact_points_guard();

-- Agents and managers record consent; the number, its type and its customer are fixed once
-- captured (capture a new contact point instead).
revoke update on public.contact_points from authenticated;
grant update (consent_status, consent_note, verified_at, updated_at) on public.contact_points to authenticated;

-- ───────────── Which contact point a queued message uses (RD-10, RD-11) ─────────────

-- The best channel first (WhatsApp, then mobile, then email); within a channel an explicit opt-in
-- first, then the most recently confirmed. A contact point never qualifies when the customer has
-- opted out on the same number or address through another contact point.
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
     and not (cp.type <> 'email' and cp.value ~ '^\+27[1-5]')
     and (new.contact_point_id is null or cp.id = new.contact_point_id)
     and (cp.consent_status = 'opted_in'
          or (v_template.category = 'utility' and cp.consent_status = 'existing_customer_s69_3'))
     and not exists (
       select 1 from public.contact_points o
       where o.customer_id = cp.customer_id and o.value = cp.value and o.consent_status = 'opted_out'
     )
   order by case cp.type when 'whatsapp' then 0 when 'mobile' then 1 else 2 end,
            (cp.consent_status = 'opted_in') desc,
            cp.verified_at desc nulls last,
            cp.created_at
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

-- ───────────── Reachable only by Desk users (RD-01) ─────────────

-- A login that is not a Desk user (no agents row) sees nothing, reference tables included.
drop policy templates_select on public.templates;
create policy templates_select on public.templates for select to authenticated
  using (public.my_role() is not null);

drop policy priceplan_rules_select on public.priceplan_rules;
create policy priceplan_rules_select on public.priceplan_rules for select to authenticated
  using (public.my_role() is not null);

-- Supabase grants EXECUTE on new public functions to signed-in users by default. Internal helpers
-- that write are for the import functions only.
revoke execute on function public.match_optouts() from public, anon, authenticated;

-- Trigger functions are never called directly.
revoke execute on function public.interactions_guard() from public, anon, authenticated;
revoke execute on function public.contact_points_guard() from public, anon, authenticated;
