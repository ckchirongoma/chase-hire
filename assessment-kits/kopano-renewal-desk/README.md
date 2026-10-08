# Kopano Renewal Desk

The Virtual Sales team's renewal desk: one record per customer, a 90-day renewal queue, outcome
logging with mandatory callback dates, template messages that respect opt-outs and consent, a
manager exceptions view, and the monthly import of the Network's base export.

This is the hardened version of the BA's two-day MVP. It is safe to load real customer data into:
every table has row level security, agents see only their own customers, nothing is readable
without signing in, and the server key never reaches the browser.

## Architecture

```
Browser ──► Next.js 15 (App Router, TypeScript) on Vercel / any Node host
              │  pages and /api/* route handlers act AS THE SIGNED-IN USER
              │  (Supabase session cookie, or `Authorization: Bearer <token>` for API clients)
              ▼
            Supabase
              ├─ Auth (email + password; logins are created by a manager or the seed)
              ├─ Postgres with RLS on every table (supabase/migrations/)
              │    ├─ rules in the database: RD-07 check constraint, RD-11 trigger,
              │    │  contract status derived from the end date, renewal-queue views
              │    └─ imports as SECURITY DEFINER functions: one transaction per file
              └─ (no storage needed: uploads are parsed in the request)
            OpenRouter (AI summary only; per-user rate limit, 400-token cap)
```

| Path | What it is |
|---|---|
| `app/queue` | Renewal queue: active lines ending in the next 90 days, eligibility from the end date and the price-plan rule |
| `app/customers/[id]` | Customer view: accounts, lines (including ported ones), contact points with consent, history, outcome form, messaging, AI summary |
| `app/manager` | Exceptions: overdue callbacks, eligible customers without a next action, no consented contact, unallocated, opt-out entries to check |
| `app/import` | Monthly import with the quarantine report and the import log |
| `app/api/*` | `health`, `summary`, `outcomes`, `messages`, `import`, `contact-points/consent`, `allocations` |
| `lib/import/` | Parsing and normalising (pure, unit-tested); the database functions apply the result |
| `supabase/migrations/` | The whole schema, RLS, rules and import functions. `supabase db reset` rebuilds it |
| `scripts/seed.ts` | Creates the logins and loads the client's files through the same import code |

## Run it locally

Needs Node 20+ and Docker.

```bash
npm install
npx supabase start                  # local stack on ports 55321 (API) / 55322 (DB); applies migrations
cp .env.example .env.local          # then paste API_URL, PUBLISHABLE_KEY and SECRET_KEY from:
npx supabase status -o env
mkdir -p data && cp /path/to/base_month1.xlsx /path/to/contacts_agent_sheets.xlsx /path/to/optouts_legal.xlsx data/
SEED_PASSWORD='choose-a-password' npm run seed -- --data ./data   # prints the three logins
npm run dev                         # http://localhost:3100
```

Optional, for the AI summary without a key: `npm run ai:stub` and set
`OPENROUTER_BASE_URL=http://127.0.0.1:55400/api/v1` and any `OPENROUTER_API_KEY`.

Tests: `npm test` (unit, no database) and `npm run test:db` (RLS, RD-07, RD-11 and the import
against the local stack; **it empties the business tables**, so re-run the seed afterwards).
CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests, the build, then starts Supabase
from the migrations and runs the database tests.

Stop the stack with `npx supabase stop`.

## Deploying

1. Create a Supabase project. Link it and push the migrations: `npx supabase link --project-ref <ref> && npx supabase db push`.
2. Deploy the app (Vercel Hobby works) with `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`. The server key is **not** needed by the app.
3. Seed from your machine with the project's URL and server key in `.env.local`: `npm run seed -- --data ./data`.
4. Check `GET /api/health` returns `{"ok":true,"db":"ok"}`.

Rollback: redeploy the previous build on the host; migrations only ever add, so the previous
build keeps working against the newer schema.

## Decisions

- **Rules live in the database as well as the UI.** RD-07 is a check constraint and RD-11 a trigger, so a REST call or a future script cannot bypass them. The API repeats the checks only to give a clear message.
- **Imports are all-or-nothing.** The app parses and normalises the file; one Postgres function applies it in a single transaction. A changed file structure stops the import before anything is written, naming the column.
- **Identity.** Customer: account number already known → registration number → normalised name. Line: E.164 number. Re-importing a file changes nothing (unchanged rows are not even touched).
- **Lines that disappear are ported, not deleted.** They are marked inactive with a date, so their history stays. A file that would mark more than a quarter of active lines as ported is refused as a probable partial export.
- **Untrusted cells are quarantined, not guessed.** Unusable numbers skip the line; ambiguous (05/11/2027), impossible and 1970 dates keep the line but not the date. Every case is listed with its reason on the Import page.
- **Contract status is derived from the end date** by a trigger, and refreshed on every import; the export's own status column is only used to report how stale it is.
- **Opt-outs are matched by name**, exactly and then by a unique near match (two typos at most); near matches are shown to the manager to confirm. "Under legal review" counts as opted out.
- **Consent per contact point.** Numbers from agents' sheets start as "existing customer" (utility messages only); marketing needs an opt-in recorded on a call. See `docs/ADR-001.md`.
- **AI summary**: signed-in users only, 5 a minute and 60 a day per user (counted in the database), 400 output tokens, only the one customer's record (numbers masked), and the agent's question kept apart from the instructions.

## Found and fixed (compared with the MVP)

| # | What was wrong | Fix |
|---|---|---|
| 1 | `customers` had RLS disabled: anyone with the public key could read every customer | RLS on every table; policies by allocation; `anon` has no grants |
| 2 | `interactions` policy was `using (true)`: every agent saw every agent's calls | Policy by allocated customer; inserts only as yourself |
| 3 | A "demo" policy let anonymous visitors read `lines` | Removed; all `anon` grants revoked |
| 4 | The server key was in `NEXT_PUBLIC_SUPABASE_SERVICE_KEY` and used in a client component, so it shipped to every browser | Key removed from the client; writes go through API routes as the user. The old key must be rotated in the Supabase dashboard |
| 5 | `/api/summary` had no auth, no rate limit and no token cap | Auth (401), per-user limits (429), `max_tokens` 400 |
| 6 | The AI prompt mixed the agent's text with other customers' data | One customer's record only, numbers masked, question delimited and treated as data |
| 7 | No migrations; `schema.sql` did not match the live database | `supabase/migrations/` rebuilds everything; CI applies them from scratch |
| 8 | The import deleted everything and re-inserted, so IDs changed and history was orphaned | Idempotent upsert on account number / registration number / E.164 number; ported lines kept |
| 9 | Phone numbers stored as numbers (leading zero lost) | E.164 text with a mobile/landline flag |
| 10 | "Call back" could be saved without a date (UI-only check) | API validation and a database constraint |
| 11 | Contract status copied from the stale export column | Derived from the end date |
| 12 | The opt-out list was never applied to messaging | Matched to customers; API check and a database trigger |
| 13 | `.env.local` with the OpenRouter key was committed, then deleted (still in history) | Key revoked and rotated; `.env*` ignored; history rewritten with `git filter-repo` |
| 14 | The import had no error handling: a bad row crashed it half-way, silently | Single transaction, quarantine report, loud failure naming the column |

## Deliberately not done

- Sending messages: the Desk only queues them; the Network's platform sends (and needs template approval).
- Dialler integration: there is no API; the nightly CSV can be loaded later.
- Bulk outreach and campaign tools: out of scope until the contactable share passes 60%.
- Fuzzy matching of customers across different registration numbers: the Network should supply registration numbers.
