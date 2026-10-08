# INTERNAL: Client context (never shown to candidates)

This file explains why the assessments look the way they do. The new hires will work on these projects, and the scenarios are anonymised versions of them.

## Cosmo ICT (an MTN dealer) → assessment client "Kopano Connect"

**The engagement**
- Chase is building a central operating layer for Cosmo, replacing spreadsheets.
- Owner and decision-maker: Thokozani Nhlapo.
- Thokozani confirmed **VSAM as the pilot** on 7 Oct 2026, with Mbuso as the channel lead.

**MVP scope (7 Oct session)**
- Monthly import from Power BI and the online portal. Excludes opted-out, legally reviewed and duplicate records.
- Allocation of records to agents.
- Outcome logging, with mandatory callback dates and email reminders.
- A manager exceptions view.
- Customer history.
- Document upload.
- Not yet designed: the admin ticket workflow.
- Not in the 15-day sprint: full omnichannel.

**Integrations**
- Solgari has no public API, only a scheduled export plus a Fabric/Power BI connector (Johan Swanepoel, 7 Oct).
- Everlytic: email and WhatsApp.
- MTN messaging platform: developer access approved.
- Hosting: Chase on Supabase, or Cosmo's own Microsoft environment.

**Value framing (Marcus Hiscock, 7 Oct)**
- 2,186 telesales records have no call recorded.
- 3,398 voicemails with no retry.
- 47 quoted inbound callers produced 2 pipeline entries.
- 54 September account-management opportunities are unclosed.
- 518 lines fall out of contract in the next 4 months.

**Commercials**
- Implementation fee capped at R200k.
- After that, an all-inclusive monthly fee that funds a dedicated BA, with an SLA.

**Why it matters for hiring:** the BA hire will be the dedicated SLA analyst on accounts like this. The SWE hire productionises builds like this one and hosts them in client environments.

## Gallo Music / Content Connect Africa / MAD → assessment client "Mzansi Heritage Records"

**The proposal (25 Sep 2026, via Mike Mpanya)**
- A Catalogue Protection & Rights Monitoring System.
- Catalogue: 127k+ tracks, distributed to about 250 platforms via aggregators (Ingrooves / Virgin Music).
- Pipeline: Extract → Match → Score → Remember → Route.

**Price**
- R525k over 12 weeks:
  - R75k discovery
  - R250k song-level monitoring
  - R200k stem/sample detection
- R20–35k/month to run.

**Existing stack**
- FileMaker
- Postgres/S3
- the MAD platform with a DAW
- an in-progress fingerprint database

**Contacts:** Antos Stella, Munashe Moyo, Ian Osrin.

**Why it matters for hiring:** SWE Test 2 asks candidates to scope this system independently. The research for the answer key (doc 08, doc 14) found several things that should shape **our own** discovery phase:
- the Content ID conflict with the aggregator
- the platform API limits
- the free registries
- the legal risk of automated takedowns

## Aurachain / FraudWatch (via Mike) → not used in assessments

**The engagement**
- A partnership to bring FraudWatch, a transaction-level fraud-intelligence product, to SA and Africa.
- First target: Liberty. Visit planned for the week of 26 Oct 2026.

**Open questions**
- Unified identity across channels.
- Hosting in the client's Azure/AWS.
- Indemnification.

**Why it matters for hiring:** the SWE must be able to deploy into enterprise clients' clouds, not only Vercel. The data-engineering competency, identity resolution, is the same one tested in SWE Test 1.
