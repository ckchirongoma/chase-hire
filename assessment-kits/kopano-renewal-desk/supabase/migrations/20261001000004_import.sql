-- Imports. The app parses and normalises each file (lib/import/*), then hands the clean rows to
-- one of these functions. Each function runs in a single transaction: it either applies the
-- whole file or nothing. Only managers (or the service role, for the seed script) may call them.

create or replace function public.assert_can_import()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (public.is_manager() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'Only a manager can import files.' using errcode = '42501';
  end if;
end;
$$;

-- ───────────── Opt-out matching (RD-11) ─────────────

-- Legal's list names companies, so entries are matched to customers by normalised name, then by
-- a unique near match (a typo of up to two characters) for names of eight characters or more.
-- Near matches are marked 'fuzzy' so a manager can confirm them on the exceptions page.
create or replace function public.match_optouts()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_best uuid;
  v_dist integer;
  v_n integer;
  v_exact integer := 0;
  v_fuzzy integer := 0;
begin
  update public.optouts o
     set customer_id = c.id, match_method = 'exact', match_distance = 0, updated_at = now()
    from public.customers c
   where o.customer_id is null
     and c.normalised_name = o.normalised_name;
  get diagnostics v_exact = row_count;

  for r in
    select o.id, o.normalised_name from public.optouts o
    where o.customer_id is null and length(o.normalised_name) >= 8
  loop
    select min(extensions.levenshtein(c.normalised_name, r.normalised_name))
      into v_dist
      from public.customers c
     where abs(length(c.normalised_name) - length(r.normalised_name)) <= 2;
    if v_dist is null or v_dist > 2 then
      continue;
    end if;
    select count(*), (array_agg(c.id))[1]
      into v_n, v_best
      from public.customers c
     where abs(length(c.normalised_name) - length(r.normalised_name)) <= 2
       and extensions.levenshtein(c.normalised_name, r.normalised_name) = v_dist;
    if v_n = 1 then
      update public.optouts
         set customer_id = v_best, match_method = 'fuzzy', match_distance = v_dist, updated_at = now()
       where id = r.id;
      v_fuzzy := v_fuzzy + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'matched_exact', v_exact,
    'matched_fuzzy', v_fuzzy,
    'unmatched', (select count(*) from public.optouts where customer_id is null)
  );
end;
$$;

-- Legal's list is the source of truth for who must not be contacted. Entries are added or
-- updated, never removed by an import (removing an opt-out is a manual, logged decision).
create or replace function public.import_optouts(p_file_name text, p_file_sha256 text, p_rows jsonb, p_quarantine jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run uuid;
  v_inserted integer;
  v_updated integer;
  v_match jsonb;
  v_counts jsonb;
begin
  perform public.assert_can_import();
  perform pg_advisory_xact_lock(hashtext('public.import'));

  insert into public.import_runs (kind, file_name, file_sha256, status, created_by)
  values ('optouts', p_file_name, p_file_sha256, 'running', auth.uid())
  returning id into v_run;

  with src as (
    select distinct on (x.normalised_name) x.*
    from jsonb_to_recordset(p_rows) as x(company_name text, normalised_name text, status text, reason text, logged_on date, row_number integer)
    order by x.normalised_name, x.row_number
  ), upserted as (
    insert into public.optouts as o (company_name, normalised_name, status, reason, logged_on)
    select s.company_name, s.normalised_name, s.status, s.reason, s.logged_on from src s
    on conflict (normalised_name) do update
      set status = excluded.status, reason = excluded.reason, logged_on = excluded.logged_on, updated_at = now()
      where (o.status, o.reason, o.logged_on) is distinct from (excluded.status, excluded.reason, excluded.logged_on)
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_inserted, v_updated
    from upserted;

  insert into public.quarantine_rows (import_run_id, row_number, reason, detail, raw)
  select v_run, q.row_number, q.reason, q.detail, coalesce(q.raw, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_quarantine, '[]'::jsonb)) as q(row_number integer, reason text, detail text, raw jsonb);

  v_match := public.match_optouts();
  v_counts := jsonb_build_object(
    'listed', (select count(*) from public.optouts),
    'inserted', v_inserted,
    'updated', v_updated,
    'quarantined', jsonb_array_length(coalesce(p_quarantine, '[]'::jsonb))
  ) || v_match;

  update public.import_runs set status = 'succeeded', counts = v_counts, finished_at = now() where id = v_run;
  return jsonb_build_object('run_id', v_run, 'counts', v_counts);
end;
$$;

-- Agents' personal contact sheets, merged into shared contact points (one-off, re-runnable).
create or replace function public.import_contacts(p_file_name text, p_file_sha256 text, p_rows jsonb, p_quarantine jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run uuid;
  v_inserted integer;
  v_unmatched integer;
  v_counts jsonb;
begin
  perform public.assert_can_import();
  perform pg_advisory_xact_lock(hashtext('public.import'));

  insert into public.import_runs (kind, file_name, file_sha256, status, created_by)
  values ('contacts', p_file_name, p_file_sha256, 'running', auth.uid())
  returning id into v_run;

  create temp table _contacts on commit drop as
  select x.*,
         coalesce(
           (select a.customer_id from public.accounts a where a.account_no = x.account_no),
           (select c.id from public.customers c where c.normalised_name = x.normalised_name order by c.created_at limit 1)
         ) as customer_id
  from jsonb_to_recordset(p_rows) as x(
    row_number integer, sheet text, account_no text, normalised_name text, type text, value text,
    person_name text, role text, consent_status text, source text, raw jsonb
  );

  insert into public.quarantine_rows (import_run_id, row_number, reason, detail, raw)
  select v_run, q.row_number, q.reason, q.detail, coalesce(q.raw, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_quarantine, '[]'::jsonb)) as q(row_number integer, reason text, detail text, raw jsonb);

  insert into public.quarantine_rows (import_run_id, row_number, reason, detail, raw)
  select v_run, t.row_number, 'unknown_customer',
         format('Sheet "%s": no customer with account %s or name %s', t.sheet, coalesce(t.account_no, '(blank)'), t.normalised_name),
         coalesce(t.raw, '{}'::jsonb)
  from _contacts t
  where t.customer_id is null;
  get diagnostics v_unmatched = row_count;

  with ins as (
    insert into public.contact_points (customer_id, type, value, person_name, role, consent_status, source)
    select distinct on (t.customer_id, t.type, t.value)
           t.customer_id, t.type, t.value, t.person_name, t.role, t.consent_status, t.source
    from _contacts t
    where t.customer_id is not null
    order by t.customer_id, t.type, t.value, t.row_number
    on conflict (customer_id, type, value) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  v_counts := jsonb_build_object(
    'rows', jsonb_array_length(p_rows),
    'contact_points_added', v_inserted,
    'unknown_customer_rows', v_unmatched,
    'quarantined', v_unmatched + jsonb_array_length(coalesce(p_quarantine, '[]'::jsonb))
  );
  update public.import_runs set status = 'succeeded', counts = v_counts, finished_at = now() where id = v_run;
  return jsonb_build_object('run_id', v_run, 'counts', v_counts);
end;
$$;

-- A failed import is logged (outside the failed transaction) so the manager sees it.
create or replace function public.record_import_failure(p_kind text, p_file_name text, p_file_sha256 text, p_error text, p_counts jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run uuid;
begin
  perform public.assert_can_import();
  insert into public.import_runs (kind, file_name, file_sha256, status, counts, error, created_by, finished_at)
  values (p_kind, p_file_name, p_file_sha256, 'failed', coalesce(p_counts, '{}'::jsonb), left(p_error, 2000), auth.uid(), now())
  returning id into v_run;
  return v_run;
end;
$$;

-- ───────────── The monthly base import ─────────────
-- Idempotent: customers are found by account number, then registration number, then normalised
-- name; accounts by account number; lines by E.164 number. Unchanged rows are not touched, so
-- re-importing the same file changes nothing. Lines missing from the file are marked ported out
-- (inactive), never deleted, so their history stays.
create or replace function public.import_base(
  p_file_name text,
  p_file_sha256 text,
  p_accounts jsonb,
  p_lines jsonb,
  p_seen_msisdns text[],
  p_quarantine jsonb,
  p_file_stats jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run uuid;
  v_acc record;
  v_customer uuid;
  v_inserted boolean;
  v_new_customers integer := 0;
  v_updated_customers integer := 0;
  v_new_accounts integer := 0;
  v_updated_accounts integer := 0;
  v_new_lines integer := 0;
  v_updated_lines integer := 0;
  v_reactivated integer := 0;
  v_ported integer := 0;
  v_status_refreshed integer := 0;
  v_active_before integer;
  v_counts jsonb;
  v_match jsonb;
begin
  perform public.assert_can_import();
  perform pg_advisory_xact_lock(hashtext('public.import'));

  insert into public.import_runs (kind, file_name, file_sha256, status, created_by)
  values ('base', p_file_name, p_file_sha256, 'running', auth.uid())
  returning id into v_run;

  v_status_refreshed := public.refresh_contract_status();
  select count(*) into v_active_before from public.lines where active;

  create temp table _acc on commit drop as
  select * from jsonb_to_recordset(p_accounts) as x(
    account_no text, reg_no text, legal_name text, normalised_name text, segment text, dealer_code text
  );
  create temp table _lines on commit drop as
  select * from jsonb_to_recordset(p_lines) as x(
    account_no text, msisdn_e164 text, number_type text, priceplan text, priceplan_name text, term_months integer,
    contract_end_date date, end_date_trusted boolean, device text, monthly_charge_zar numeric
  );
  create temp table _seen (msisdn_e164 text primary key) on commit drop;
  insert into _seen select distinct s from unnest(coalesce(p_seen_msisdns, '{}'::text[])) as s where s is not null;
  insert into _seen select l.msisdn_e164 from _lines l on conflict do nothing;

  -- 1. Customers and accounts. Accounts that carry a registration number go first, so accounts
  --    without one can join the same customer by name.
  for v_acc in select * from _acc order by (reg_no is null), account_no loop
    v_customer := null;
    select a.customer_id into v_customer from public.accounts a where a.account_no = v_acc.account_no;
    if v_customer is null and v_acc.reg_no is not null then
      select c.id into v_customer from public.customers c where c.reg_no = v_acc.reg_no;
    end if;
    if v_customer is null then
      select c.id into v_customer
        from public.customers c
       where c.normalised_name = v_acc.normalised_name
         and (c.reg_no is null or v_acc.reg_no is null)
       order by (c.reg_no is null), c.created_at
       limit 1;
    end if;

    if v_customer is null then
      insert into public.customers (legal_name, normalised_name, reg_no, segment)
      values (v_acc.legal_name, v_acc.normalised_name, v_acc.reg_no, v_acc.segment)
      returning id into v_customer;
      v_new_customers := v_new_customers + 1;
    else
      update public.customers c
         set reg_no = coalesce(c.reg_no, v_acc.reg_no),
             segment = coalesce(v_acc.segment, c.segment),
             updated_at = now()
       where c.id = v_customer
         and ((c.reg_no is null and v_acc.reg_no is not null
               and not exists (select 1 from public.customers c2 where c2.reg_no = v_acc.reg_no))
              or c.segment is distinct from coalesce(v_acc.segment, c.segment));
      if found then
        v_updated_customers := v_updated_customers + 1;
      end if;
    end if;

    v_inserted := null;
    insert into public.accounts as a (customer_id, account_no, dealer_code)
    values (v_customer, v_acc.account_no, v_acc.dealer_code)
    on conflict (account_no) do update
      set dealer_code = excluded.dealer_code, updated_at = now()
      where a.dealer_code is distinct from excluded.dealer_code
    returning (xmax = 0) into v_inserted;
    if v_inserted then
      v_new_accounts := v_new_accounts + 1;
    elsif v_inserted is not null then
      v_updated_accounts := v_updated_accounts + 1;
    end if;
  end loop;

  -- 2. Lines that come back after being marked ported out.
  update public.lines t
     set active = true, ported_out_at = null, updated_at = now()
   where not t.active and exists (select 1 from _seen s where s.msisdn_e164 = t.msisdn_e164);
  get diagnostics v_reactivated = row_count;

  -- 3. Changed lines (only rows whose values differ are touched).
  with src as (
    select l.*, a.id as account_id
    from _lines l join public.accounts a on a.account_no = l.account_no
  )
  update public.lines t
     set account_id = s.account_id,
         number_type = s.number_type,
         priceplan = s.priceplan,
         priceplan_name = s.priceplan_name,
         term_months = s.term_months,
         device = s.device,
         monthly_charge_zar = s.monthly_charge_zar,
         contract_end_date = case when s.end_date_trusted then s.contract_end_date else t.contract_end_date end,
         updated_at = now()
    from src s
   where t.msisdn_e164 = s.msisdn_e164
     and (t.account_id, t.number_type, t.priceplan, t.priceplan_name, t.term_months, t.device, t.monthly_charge_zar,
          t.contract_end_date)
         is distinct from
         (s.account_id, s.number_type, s.priceplan, s.priceplan_name, s.term_months, s.device, s.monthly_charge_zar,
          case when s.end_date_trusted then s.contract_end_date else t.contract_end_date end);
  get diagnostics v_updated_lines = row_count;

  -- 4. New lines.
  insert into public.lines (account_id, msisdn_e164, number_type, priceplan, priceplan_name, term_months,
                            contract_end_date, device, monthly_charge_zar)
  select a.id, l.msisdn_e164, l.number_type, l.priceplan, l.priceplan_name, l.term_months,
         case when l.end_date_trusted then l.contract_end_date end, l.device, l.monthly_charge_zar
    from _lines l
    join public.accounts a on a.account_no = l.account_no
   where not exists (select 1 from public.lines t where t.msisdn_e164 = l.msisdn_e164);
  get diagnostics v_new_lines = row_count;

  -- 5. Lines missing from this month's file have ported out: mark them, keep them.
  update public.lines t
     set active = false, ported_out_at = now(), updated_at = now()
   where t.active and not exists (select 1 from _seen s where s.msisdn_e164 = t.msisdn_e164);
  get diagnostics v_ported = row_count;
  if v_active_before > 0 and v_ported > greatest(25, v_active_before / 4) then
    raise exception 'This file would mark % of % active lines as ported out. That looks like a partial export, so nothing was imported.',
      v_ported, v_active_before using errcode = 'P0001', hint = 'partial_file';
  end if;

  -- 6. The quarantine report.
  insert into public.quarantine_rows (import_run_id, row_number, reason, detail, raw)
  select v_run, q.row_number, q.reason, q.detail, coalesce(q.raw, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_quarantine, '[]'::jsonb)) as q(row_number integer, reason text, detail text, raw jsonb);

  -- 7. New customers may be on Legal's list.
  v_match := public.match_optouts();

  v_counts := coalesce(p_file_stats, '{}'::jsonb) || jsonb_build_object(
    'customers_new', v_new_customers,
    'customers_updated', v_updated_customers,
    'accounts_new', v_new_accounts,
    'accounts_updated', v_updated_accounts,
    'lines_new', v_new_lines,
    'lines_updated', v_updated_lines,
    'lines_reactivated', v_reactivated,
    'lines_ported_out', v_ported,
    'statuses_refreshed', v_status_refreshed,
    'quarantined', jsonb_array_length(coalesce(p_quarantine, '[]'::jsonb)),
    'customers_total', (select count(*) from public.customers),
    'lines_active', (select count(*) from public.lines where active),
    'optouts', v_match
  );
  update public.import_runs set status = 'succeeded', counts = v_counts, finished_at = now() where id = v_run;
  return jsonb_build_object('run_id', v_run, 'counts', v_counts);
end;
$$;

revoke execute on function public.assert_can_import() from public, anon;
revoke execute on function public.match_optouts() from public, anon;
revoke execute on function public.import_optouts(text, text, jsonb, jsonb) from public, anon;
revoke execute on function public.import_contacts(text, text, jsonb, jsonb) from public, anon;
revoke execute on function public.record_import_failure(text, text, text, text, jsonb) from public, anon;
revoke execute on function public.import_base(text, text, jsonb, jsonb, text[], jsonb, jsonb) from public, anon;
grant execute on function public.assert_can_import() to authenticated, service_role;
grant execute on function public.match_optouts() to service_role;
grant execute on function public.import_optouts(text, text, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.import_contacts(text, text, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.record_import_failure(text, text, text, text, jsonb) to authenticated, service_role;
grant execute on function public.import_base(text, text, jsonb, jsonb, text[], jsonb, jsonb) to authenticated, service_role;
