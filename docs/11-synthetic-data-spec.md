# 11: Synthetic Data Spec

## Generator

- **Script:** `scripts/synth/generate.ts` (Node) or `scripts/synth/generate.py`, run with a fixed seed.
- **Output:** a versioned bundle uploaded to `datasets/v{n}/`.
- **No real data, ever.** The generator copies the *structure and defect proportions* of the real Cosmo workbook (`context/cosmo-defect-catalogue.md`). It never copies its values.
- **Fake data sources:**
  - Company names: SA-flavoured patterns, e.g. `{Surname} {Industry} (Pty) Ltd`, `{Word} Trading CC`.
  - Phone numbers: in the fictional/reserved ranges where possible. Otherwise random, but never taken from real lists.
  - Emails: on `@example.co.za`.

## Bundle A: `kopano_vsam_extract.xlsx` (BA Part 1)

### Sheet `vsam base raw`

- **Size:** about 5,000 lines across about 1,350 accounts.
- **Columns** (same names as the real sheet):
  Account No, Msisdn, Customer Name, dealer_code, Telemetry, Bam Flag, Region, Channel, Segment, RSM, AM, Contract Term, Contract End Date, Contract Status, Month Remaining In Contract, Priceplan Category, Priceplan, Priceplan Name, Package, Package Name, Tariff, Tariff Name, Device Type, Device Manufacturer, Device Model, chg_subs

**Distributions to mimic:**
- **Lines per account:** heavy-tailed. Median 2, maximum about 70.
- **Segment:** SME about 98%, LE about 1.5%, PE trace.
- **Contract term:** 24 months about 63%, 36 months about 33%, plus small counts of 1, 3, 6, 12 and 18 months.
- **Contract status:** about 33% Out Of Contract.
- **End-date window:** about 9% of lines have an end date in the next 90 days, counted from the "export date" `2026-10-07`.
- **chg_subs** (monthly charge in rands): median about R310, IQR about R140–R520, maximum about R2,700. About 6% are 0, and about 0.6% are blank.
- **Devices:** about 37% of lines have no device.

### Sheet `worksheet` (one agent's working file)

- **Size:** about 125 accounts, all assigned to one consultant.
- **Columns:** same as the real sheet, including the headerless column F (notes) and the `Status (clean)`, `Date digits (helper)` and `Date (clean)` columns.

### Sheet `solgari September stats` → rename to `dialler September stats`

- **Size:** 19 "agents".
- **Contents:** aggregate columns only. Include `test 23` and `Dialler Support`.

### Sheet `interval log`

- **Size:** 4 agents × 22 working days.
- **Target string:** `104 / 52 / 21 / 6`.
- **Funnel totals:** about 1,700 calls → about 870 connected → about 75 opportunities → about 22 sales.

## Planted defects (D-codes used in the answer key, doc 06)

| ID | Inject | Count / rate |
|---|---|---|
| D01 | Line-grain base; no company reg. number column; no customer ID beyond Account No | Structural |
| D02 | No phone/email/WhatsApp columns in the base. Contact data only in the worksheet, covering about 9% of accounts | Structural |
| D03 | The same company under 2 accounts: exact name (5 pairs) + spacing/"(PTY) LTD" variants (2 more) | 7 pairs |
| D04 | Worksheet accounts absent from the base | 4 |
| D05 | Contact column: `(083) 2728600` style about 70%, leading-zero-stripped integers about 12%, `0` placeholder about 13%, landlines mixed in | as stated |
| D06 | Account Holder Name `0` | about 54% of worksheet rows; email blank in about 55% |
| D07 | Contact column has mixed numeric and string cell types | as D05 |
| D08 | `date contacted`: US `m/d/yyyy` strings, `08/12/2026` ambiguous, `2026/13/08` (YYYY/DD/MM), real Excel dates, blanks | about 111 strings (3 impossible), 16 real dates, 16 blanks |
| D09 | `Completed Allocated Blocks? (4/4)` stored as dates (`3/4` → 2026-03-04) for completed days; `0/4` text otherwise | as stated |
| D10 | Contract End Date = 1970-01-01 with term 0 | 5 lines |
| D11 | Contract Status `InContract` but end date before the export date | about 105 lines |
| D12 | `Month Remaining In Contract` text buckets, including `Unknown` | as real |
| D13 | Free-text Call Status variants with trailing spaces; a notes column with no header | as stated |
| D14 | `Next Action`, `Action Required` 100% empty; 9 rows with "Call back / Follow up" and no date anywhere | as stated |
| D15 | 10 "Engaged Requested quote" rows; only 1 Processing + 1 Approved in Application Status | as stated |
| D16 | `Comment Status` = DONE on about 88% of rows, including dead calls | as stated |
| D17 | Worksheet `Out Of Contract` count disagrees with the base for about 4% of matched accounts | about 5 |
| D18 | Constant columns; AM name misspelt in the base vs correct in the dialler sheet | as stated |
| D19 | Dialler sheet has no per-call rows, no MSISDN, no timestamps | Structural |
| D20 | Agent names not consistent across sheets; system/test users present | as stated |
| D21 | Interval log headers with trailing spaces; packed target string; booked-off days recorded as 0s; Day Status sparse | as stated |
| D22 | Funnel shape per the interval-log totals above | as stated |
| D23 | No consent/opt-out column anywhere in the base | Structural |

**Answer-key generation.** The generator writes `answer_key.json`, recording the exact counts and row IDs of every planted defect in that bundle version. The graders use this file, which means grading still works if proportions are tweaked.

## Bundle B: BA Part 2 "fixed" data (`kopano_clean_v{n}`)

Provide this as CSVs and as a Supabase seed SQL.

| Table | Contents |
|---|---|
| `customers` | id, legal_name, reg_no, segment, normalised_name |
| `accounts` | id, customer_id, account_no, dealer_code |
| `lines` | id, account_id, msisdn_e164, priceplan, term_months, contract_end_date, device, monthly_charge_zar, status (derived), eligible_from (applying the H07 rule) |
| `contact_points` | id, customer_id, type (mobile/landline/email/whatsapp), value, role (decision_maker/admin/unknown), verified_at, consent_status (opted_in/existing_customer_s69_3/opted_out/unknown), source |
| `agents` | id, name, role |
| `interactions` | id, customer_id, agent_id, type, outcome, next_action_at, notes, created_at; about 300 historical rows |
| `templates` | id, name, category (utility/marketing), body, approved |

**Contactability in the cleaned data:** about 45% of customers have at least one verified, consented contact point. That is deliberately below the Solution Brief's 60% gate, so the exceptions view has something to show.

## Bundle C: SWE Test 1

| File | Contents |
|---|---|
| `base_month1.xlsx` | Base sheet only, with defects D05, D08, D10, D11 and phone-as-number. Includes `Account No` and a synthetic `Reg No` column, about 92% populated, so a natural key is available but imperfect |
| `contacts_agent_sheets.xlsx` | Agent contact files: 3 agents, overlapping customers with conflicting contact data |
| `optouts_legal.xlsx` | About 40 opt-outs listed by **company name only**, with spelling variants. The candidate must match them to customers (RD-11) |
| `base_month2.xlsx` | Held back. Deltas: 4% of lines changed, 2% new (15 for existing customers), 1.5% removed, 30 duplicate rows, 20 new phone defects, 10 ambiguous dates |
| `base_month2_drift.xlsx` | Held back. `Contract End Date` renamed to `Contract_End`, plus one added column `Sales_Rep` |
| `expected_month2.json` | The correct post-import counts and sentinel IDs the harness checks against |

## Bundle D: SWE Test 2

The text data room only: the brief, a stack description, people, volumes, and the legal note. There is no audio.

## Versioning

- Every bundle has a version string, and `work_stages.dataset_bundle` points to it.
- Rotate to a new seed **every cohort**. Changing names and counts limits the value of shared answers, and the graders read counts from `answer_key.json`.
