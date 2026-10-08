# 16: SWE Test 1 starter app and harness contract (INTERNAL)

The SWE Test 1 starter ("Kopano Renewal Desk") and the verification harness are built
separately, so they share this contract. Candidates harden the starter; the harness probes
their deployment and repo using these names. Candidates may rename things, in which case the
affected automated checks report "inconclusive" and a reviewer records the result manually.

**Never show this file to candidates** (it maps checks to planted faults).

## Code layout

- `assessment-kits/kopano-renewal-desk/`: the **reference** app (correct, passes every check).
  Next.js App Router + TypeScript + Supabase (its own `supabase/` folder and config with
  non-default local ports so it can run beside the platform's stack) + OpenRouter.
- `assessment-kits/make-starter.mjs`: copies the reference into an output folder and injects
  F01–F14, then builds a fresh git history (F13: `.env.local` committed early, deleted later).
- `assessment-kits/HANDOFF.md`: the candidate-facing handoff pack (stories RD-01…RD-12 with
  Given/When/Then ACs, business rules, access matrix, edge cases, out of scope). RD-07 and
  RD-11 are the two stories candidates must implement.

## Database (public schema)

| Table | Columns (minimum) | Notes |
|---|---|---|
| `agents` | `id uuid pk = auth.users.id`, `name`, `role` in (agent, manager, admin) | |
| `customers` | `id`, `legal_name`, `normalised_name`, `reg_no`, `segment`, `created_at` | identity: reg_no, else normalised_name |
| `accounts` | `id`, `customer_id`, `account_no unique`, `dealer_code` | |
| `lines` | `id`, `account_id`, `msisdn_e164 text`, `priceplan`, `term_months`, `contract_end_date date`, `contract_status text`, `device`, `monthly_charge_zar numeric`, `active bool`, `ported_out_at timestamptz` | status derived from end date; ported lines inactive, never deleted |
| `contact_points` | `id`, `customer_id`, `type` (mobile/landline/email/whatsapp), `value`, `role`, `consent_status`, `verified_at`, `source` | |
| `allocations` | `id`, `customer_id`, `agent_id` | agent sees only allocated customers |
| `interactions` | `id`, `customer_id`, `agent_id`, `outcome` in (call_back, quote, sale, not_interested, no_answer), `next_action_at timestamptz`, `notes`, `created_at` | RD-07: call_back requires next_action_at (DB constraint) |
| `optouts` | `id`, `company_name`, `normalised_name`, `customer_id null`, `reason`, `created_at` | RD-11: matched to customers by normalised name |
| `templates` | `id`, `name`, `category` (utility/marketing), `body`, `approved bool` | |
| `message_queue` | `id`, `customer_id`, `template_id`, `status` ('queued'), `created_by`, `created_at` | RD-11: refused for opted-out customers (DB) |
| `import_runs` | `id`, `file_name`, `status`, `counts jsonb`, `created_at` | |
| `quarantine_rows` | `id`, `import_run_id`, `row_number`, `reason`, `raw jsonb` | |

## HTTP routes

| Route | Behaviour (reference) |
|---|---|
| `GET /api/health` | `200 {"ok": true, "db": "ok"}` after a real DB query |
| `POST /api/summary` `{customerId}` | auth required (401), per-user rate limit (429), max tokens, only the caller's allocated customer's data in the prompt, user text never interpolated with other customers' data |
| `POST /api/outcomes` `{customerId, outcome, nextActionAt?, notes?}` | 4xx for `call_back` without `nextActionAt` |
| `POST /api/messages` `{customerId, templateId}` | 4xx when the customer is opted out or has no consented contact point |
| `POST /api/import` multipart `file` (manager only) | idempotent upsert; quarantine; schema drift → 4xx naming the column, no partial writes |

## Logins the candidate submits

`test_logins` must contain three lines in this format (the brief says so):
```
agent: email / password
agent: email / password
manager: email / password
```

## Check → fault map

| Check | Kind | Pass condition | Faults it catches |
|---|---|---|---|
| R1 | repo | gitleaks over history finds no live secret, or README documents rotation | F13 |
| R2 | repo | no `service_role`/`SERVICE`/`sb_secret_` in `NEXT_PUBLIC_*` or `'use client'` files | F04 |
| R3 | repo | `supabase/migrations/` exists, applies cleanly, every table has RLS | F07, F01 |
| R4 | repo | `npm ci && npm run lint && tsc --noEmit && npm run build` exit 0 | |
| R5 | repo | tests exist and pass; ≥1 covers import, ≥1 covers RD-07 | |
| R6 | repo | `.github/workflows/*` exists and the last run on the SHA is green | |
| R7 | repo | `.env*` gitignored and `.env.example` exists | F13 |
| U1 | url | `GET /api/health` 200 and reports the DB | |
| U2 | url | no service-role JWT or `sb_secret_` in HTML/JS chunks | F04 |
| U3 | url | anon REST read of customers/lines/interactions returns nothing or is refused; anon insert refused | F01, F03 |
| U4 | url | agent A cannot read agent B's interactions/allocations (REST and app routes) | F02 |
| U5 | url | 100-request burst on `/api/summary`: 401 unauthenticated; 429 within the burst authenticated | F05 |
| U6 | url | `call_back` without date refused via REST and via `/api/outcomes` | F10 |
| U7 | url | queueing a message to an opted-out customer refused | F12 |
| U8 | url | MDN Observatory grade (informational) | |
| M1–M7 | import | month-2 file behaviour (docs/07) | F08, F14 |
| D-a | data | phones E.164 text; landlines distinguished | F09 |
| D-b | data | no expired lines with status InContract | F11 |
| D-c | data | no epoch dates | |
| — | human | prompt-injection path in `/api/summary` (F06) is judged by the reviewer and the S1 grader | F06 |

Results are written to the platform's `verification_runs` table (`check_key` = R1…M7, D-a…D-c).
Automated checks that cannot conclude record `passed = null` with `detail.inconclusive = true`.
