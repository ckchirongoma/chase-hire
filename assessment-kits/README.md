# Assessment kits (INTERNAL, for Chase admins)

This folder holds what we build once per hiring round for **SWE Test 1, Harden and Ship**
(docs/07, contract in docs/16). It is its own project: the platform's `tsc`, ESLint and Vitest
skip it, and the app inside has its own `package.json`, `node_modules` and Supabase stack.

| Path | What it is | Who may see it |
|---|---|---|
| `kopano-renewal-desk/` | The **reference** app: the correct, hardened Renewal Desk. It passes every harness check and is the answer key the starter is built from | Chase only |
| `make-starter.mjs` | Builds the candidate **starter** from the reference: injects faults F01–F14 and fakes the BA's git history | Chase only |
| `FAULTS.md` | The answer key: each planted fault, where it is injected, how it is detected, the fix | Chase only |
| `HANDOFF.md` | The BA's handoff pack (stories RD-01…RD-12, rules, access matrix). Shipped to candidates in bundle C | Candidates |
| *the generated starter* | The "vibe-coded" MVP candidates harden | Candidates |

Never give candidates the reference, `make-starter.mjs`, `FAULTS.md`, the `<out>.internal/`
folder, docs/07 or docs/16.

## 1. Run the reference app locally

Needs Node 20+ and Docker. Everything happens inside `kopano-renewal-desk/`: its Supabase stack
has its own project id and ports (below), so it runs next to the platform's stack. **Never run
`npx supabase start/stop/db reset` from the repository root**: that is the platform's stack.

```bash
cd assessment-kits/kopano-renewal-desk
npm ci
npx supabase start                      # applies supabase/migrations/ from scratch
cp .env.example .env.local              # then fill it in from the next command's output:
npx supabase status -o env              #   API_URL, PUBLISHABLE_KEY, SECRET_KEY
mkdir -p data && cp <bundle>/bundle_c/candidate/*.xlsx data/
SEED_PASSWORD='choose-a-password' npm run seed -- --data ./data   # prints the three test logins
npm run ai:stub &                       # optional: OpenRouter stand-in on :55400 (set OPENROUTER_BASE_URL)
npm run build && npm start              # http://localhost:3100
```

Tests: `npm test` (unit) and `npm run test:db` (RLS, RD-07, RD-11 and the import against the
local stack; it empties the business tables, so re-seed afterwards). Stop the stack with
`npx supabase stop` from the same folder; `npx supabase db reset` (same folder) rebuilds its
database from the migrations.

| Service | Reference kit port |
|---|---|
| API (Kong) | 55321 |
| Postgres | 55322 (shadow database 55320) |
| Mail (Mailpit) | 55324 |
| Studio, Storage, Realtime, Edge Functions, Analytics, Pooler | off |
| OpenRouter stub (`npm run ai:stub`) | 55400 |
| Next.js (`npm run dev` / `npm start`) | 3100 |

The platform's own stack uses the default 543xx ports, so the two never collide.

The seed creates `agent.a@example.co.za`, `agent.b@example.co.za` (agents, customers shared out
alternately) and `manager@example.co.za`, in the three-line `test_logins` format the harness
reads (docs/16).

## 2. Build the starter

```bash
node assessment-kits/make-starter.mjs --out ../kopano-renewal-desk-starter \
  [--internal-out ../kopano-renewal-desk-starter.internal] [--secret-seed "round-2026-11"] [--force]
```

It copies the reference (without `node_modules`, `.next`, `.env*`, `data/` and local Supabase
state), applies one named, idempotent transformation per fault (each is run twice and verified,
and every check runs again on the finished tree), replaces the README with the BA's two-day
README, deletes `supabase/migrations/` and writes an out-of-date `schema.sql` (F07), and builds a
fresh history of ten commits by "the BA". Commit 2 adds `.env.local` with an obviously fake,
high-entropy `OPENROUTER_API_KEY` (no real provider prefix, derived from `--secret-seed`);
commit 8 deletes it, so it survives only in history (F13).

`<out>.internal/` (never share) gets `live-db.sql`, the database "as the BA left it in the
dashboard" that the starter's code actually runs against, and `faults.json`, with the planted
key and the commits that add and remove it. The script refuses an `--internal-out` inside `--out`
(or the reference), and checks that neither file is ever committed to the starter's history.

Check the result before publishing:

```bash
cd ../kopano-renewal-desk-starter
npm ci && npm run lint && npx tsc --noEmit && npm run build   # all succeed: it "looks finished"
npm test                                                        # 11 tests fail in tests/normalise.test.ts (F09), by design
docker run --rm -v "$PWD:/repo:ro" ghcr.io/gitleaks/gitleaks:v8.24.3 git /repo   # 1 leak: .env.local (F13)
```

Changing a fault: change the reference first if needed, then the fault's transformation and its
`verify` in `make-starter.mjs`. The anchors are exact, so a reference change that breaks a
transformation fails loudly instead of producing a starter without the fault. Update `FAULTS.md`,
rebuild, and re-run the harness on both repos (docs/07 "Building the starter", step 4).

## 3. Publish the starter on GitHub (public)

```bash
cd ../kopano-renewal-desk-starter
gh repo create chase-hiring/kopano-renewal-desk-starter-2026-11 --public --source . --push
```

- **Why public.** The platform and the harness read candidates' repositories without signing in
  to GitHub (the R checks clone them anonymously, and CI status is read anonymously), so every
  candidate's copy must be public, and it carries the whole starter, faults and history included.
  A private starter would add a step (collecting each candidate's GitHub username and granting
  access) without keeping anything secret, so the starter is public too. Bundle C's README says
  so: no access to request, and their copy must be public. (docs/07 still says "keep both repos
  private"; that predates this decision.)
- **Vary it every round.** Copies from earlier rounds, fixes included, stay public. Rebuild the
  starter each round with a new `--secret-seed` (a new planted key), publish it under a new repo
  name, and regenerate bundle C with a new seed (section 4), so this round's data, sentinel
  customers and held-back import differ. The fault list stays the same; if earlier rounds' public
  fixes become a problem, vary the faults themselves (`make-starter.mjs` and `FAULTS.md`). The
  live defence (AI off) is the check that a candidate understands what they submitted.
- **Candidates must get the history.** A repository created with GitHub's "Use this template"
  starts from one squashed commit, which silently removes F13, and forks are listed on the
  starter where other candidates can see them. The bundle C README therefore tells candidates to
  clone the starter and push it, as it is, to a new repository of their own. Do not mark the repo
  as a template.
- **Push protection.** The planted key has no provider prefix, so GitHub push protection has
  nothing to block. If a secret-scanning alert appears on the starter repo, close it as "used in
  tests": the value was never a working key.
- Keep the reference app in this (private) repository only. Never push it anywhere a candidate
  can read.

## 4. Set STARTER_REPO_URL and regenerate bundle C

Bundle C's candidate README links the starter through the `STARTER_REPO_URL` placeholder, and
bundle C ships `HANDOFF.md` (copied from `assessment-kits/HANDOFF.md` when the bundle is
generated: edit it here, then regenerate). Use a new seed and version for every round (docs/11):

```bash
npx tsx scripts/synth/generate.ts --version v2 --seed 20261107 \
  --starter-repo-url https://github.com/chase-hiring/kopano-renewal-desk-starter-2026-11
npx tsx --env-file=.env.local scripts/synth/upload.ts --version v2
```

The link can also be given at upload time (`--starter-repo-url`, or the `STARTER_REPO_URL`
environment variable). It must be `https://github.com/<owner>/<repo>`. `generate.ts` warns and
`upload.ts` refuses to upload while a candidate file still holds a placeholder, and the platform
refuses to start a stage whose README still holds one. Then point the SWE Test 1 stage's
`dataset_bundle` at `v2/bundle_c`. The held-back month-2 files and `expected_month2.json` for the
harness's import checks land in `bundle_c/internal/`.

When you regenerate the data, reseed the reference with the new `bundle_c/candidate/*.xlsx`
files before calibrating, so the harness's sentinel customers exist.

## 5. Calibrate the harness

- **Reference:** run it as in section 1 (or deploy it: `npx supabase link` + `npx supabase db
  push`, turn off "Allow new users to sign up" under Authentication in the Supabase dashboard,
  because `db push` does not carry `config.toml`'s `enable_signup = false` to a hosted project,
  any Node host, then seed), and point the harness at it with the three seeded logins.
  Every R, U, M and D check must pass. The browser signs in with the publishable key, so the
  harness finds the Supabase project and key in the login page's JavaScript.
- **Starter:** deploy it on a fresh Supabase project with `<out>.internal/live-db.sql` applied,
  set `NEXT_PUBLIC_SUPABASE_SERVICE_KEY` to that project's server key, and seed it. Every check
  that maps to an F-code in docs/16 must fail. Details are in `FAULTS.md`, "Calibrating the
  harness".
- The month-2 import checks change the deployment's data. Reset the reference afterwards
  (`npx supabase db reset` in `kopano-renewal-desk/`, then seed again).
