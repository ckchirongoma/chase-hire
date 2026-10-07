# Chase Hiring Platform

Recruitment and assessment platform for Chase Agents (AI-native BA and SWE roles).
Read `CLAUDE.md` and `docs/` first. **Wave 1** is built: auth, POPIA consent, profile,
CV upload → parse → dedupe flags, the Reasoning Assessment (generated items, server timer,
scoring, stars), role listing and apply, and the admin candidate table.

Stack: Next.js (App Router) on Vercel · Supabase (Postgres + RLS, Auth, Storage, pgvector) · OpenRouter.

## Deploying (Vercel + Supabase)

1. **Supabase migrations**: everything in `supabase/migrations/` (already applied to the
   "Chase hire" project). New migrations: `npx supabase db push`, or apply via the dashboard.
2. **Supabase Auth settings** (dashboard → Authentication):
   - URL configuration: Site URL = your Vercel URL; add `https://<your-domain>/**` to Redirect URLs.
   - Email confirmation: on (the default).
   - Custom SMTP (Authentication → Emails → SMTP): required for real volumes. The built-in
     sender is heavily rate-limited.
3. **Vercel env vars**: see `.env.example`. `SUPABASE_SECRET_KEY` and `OPENROUTER_API_KEY` are
   server-only and must never be prefixed `NEXT_PUBLIC_`.
4. **Make yourself an admin**: sign up through the site, then run in the SQL editor:
   `insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';`
5. **Cron**: `vercel.json` runs `/api/cron/finalise-reasoning` daily (scores abandoned attempts;
   attempts are also scored lazily the next time the candidate loads the page). Set `CRON_SECRET`.

## Local development

```bash
npm install
npx supabase start            # needs Docker
cp .env.example .env.local    # fill with values from `npx supabase status`
npm run dev
```

## Tests

| Command | What |
|---|---|
| `npm test` | Unit tests (Vitest): item generators, scoring, star bands, timer, sanitiser, CV parsing, dedupe thresholds, OpenRouter client |
| `npm run test:int` | Integration tests against local Supabase: RLS on every table, no auto-reject, timer enforcement in the DB, 90-day retake rule, reasoning flow |
| `npm run test:e2e` | Playwright: sign up → confirm email → consent → CV → reasoning test → stars → apply; second account with the same CV is flagged; admin sees both. Uses a stub OpenRouter (`tests/e2e/openrouter-stub.mjs`) |

## Where things live

| Path | What |
|---|---|
| `supabase/migrations/` | Schema, RLS policies, triggers (timer, no-auto-reject guard), `apply_to_role`, `admin_decide` |
| `lib/reasoning/` | Seeded item generators (6 families × 3 tiers), blueprint, scoring/percentile/stars, timer |
| `lib/server/reasoning.ts` | Attempt lifecycle: start, serve one item at a time, answer, finalise |
| `lib/cv/`, `lib/server/cv.ts` | Text extraction, AI parsing, identity normalisation, 3-layer dedupe |
| `lib/ai/` | OpenRouter client (JSON output + Zod + one retry, zero-data-retention routing) |
| `lib/sanitise.ts` | Hostile-input sanitiser (zero-width, HTML comments, injection detection) |
| `prompts/` | Versioned prompts (`<key>.v<n>.md`) |
| `lib/consent/notice.ts` | POPIA notice text (DRAFT: needs legal review; bump the version on any change) |
| `app/admin/` | Candidate table and detail, dedupe queue, roles, item bank |
