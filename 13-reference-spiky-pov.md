# 13: Reference Spiky POV (gold-standard BA Part 1 answer)

**Status:** INTERNAL. This is the calibration anchor for graders and the gold sample with the highest score.

**Where the numbers come from:** they are computed from the real Cosmo VSAM workbook (7 Oct 2026). The synthetic bundles reproduce the same proportions. For each bundle version, regenerate the figures from `answer_key.json` before using this as a grading reference.

It is written exactly as a top candidate's submission should read: around 1,400 words in the body, followed by the appendices.

---

# Kopano Connect: Renewal Outreach Discovery

*Prepared for Lerato Dube, GM Virtual Sales.*

## Executive summary

**Don't automate outreach yet. First make the renewal base reachable, and make every conversation end in a dated next step.**

- Of the 224 accounts whose contracts end in the next 90 days, about 90% have no phone number or email anywhere in your data.
- Your team connects on half its calls, but fewer than 1 in 10 connected calls becomes an opportunity.
- WhatsApp would reach almost nobody, and the people it did reach might not have consented. After last year's SMS complaints, that risks your sender account.

**What I recommend:**
- A **6-week Renewal Desk**: one customer record, verified contacts with consent status, a 90-day renewal queue, and mandatory callback dates.
- Then **switch on WhatsApp/SMS** for customers who are contactable and consented.

**The decision I need from you:** approve the contact-capture rule and the commission change described in section 6. Also ask your Network account manager to confirm in writing that we may contact these customers about renewals.

## 1. Purpose

**Question:** what should Kopano build to grow renewals and upgrades from Virtual Sales' existing SME base?

| In scope | Out of scope |
|---|---|
| The VSAM base | Online and retail channels |
| Agent workflow | New-customer acquisition |
| Outreach channels | Dialler replacement |
| Data | |
| Compliance | |

## 2. Facts (selected; full list in Appendix A)

**The base and its contacts**
- **F1.** The base export has 5,114 rows, one per phone line (MSISDN), across 1,377 account numbers. There is no company registration number and no customer ID beyond Account No (`vsam base raw`).
- **F2.** The base has no phone, email or WhatsApp field at all. Contact details exist only in one agent's working sheet, for 127 accounts (9%) (`worksheet`).
- **F3.** In that sheet, 69 of 127 rows (54%) have `0` as the account-holder name, 70 have no email, and 17 have `0` as the phone number. Many numbers have lost their leading zero, so they cannot be used for SMS or WhatsApp as they stand.
- **F4.** 473 lines across 224 accounts reach contract end in the next 90 days. Those lines carry **R158,855 a month** in charges. Only 22 of the 224 accounts (10%) appear in the agent sheet.
- **F5.** 107 lines are marked "InContract" even though their end date has passed. Lerato confirmed the status column is "whatever it was on the day the Network ran the report" (H09).

**What happens on the phone**
- **F6.** The agent sheet's `Next Action` and `Action Required` columns are 100% empty. 9 accounts are marked "Call back / Follow up" with no date anywhere.
- **F7.** Of 10 customers who asked for a quote, 1 is processing and 1 is approved. The other 8 have no recorded next step.
- **F8.** September activity, 4 agents (`interval log`): 1,687 calls → 865 connected (51%) → 76 opportunities (8.8% of connected) → 22 sales. The target was 6 sales per agent per day, or about 528 for the month. Actual: about **4% of target**.
- **F9.** The dialler reports only agent-level totals. There are no per-call records and no API, only a nightly CSV (H05).

**From Lerato**
- **F10.** Contact details live in agents' own sheets (H01). Agents earn commission per upgrade "so they don't love sharing" (H08).
- **F11.** Opt-outs sit in a separate legal spreadsheet, keyed by company name (H04). Last year's bulk SMS drew complaints, and the Network threatened to suspend the sender (H11).
- **F12.** Customer data "is technically the Network's". The dealer agreement allows contact about Network products, renewals and upgrades (H03).

## 3. Research (what's true outside Kopano)

**POPIA s69: direct marketing by electronic communication**
- The default is opt-in.
- The **s69(3)** exception lets you market without prior consent to *your own customers*, for similar products, provided you offered an opt-out when you collected their details **and** offer one in every message.
- **Renewals fit "similar products".** But "your own customers" is exactly what F12 puts in doubt. The Information Regulator's December 2024 guidance note also brings telemarketing calls within direct marketing.
- Sources: Cliffe Dekker Hofmeyr (Jan 2025); DLA Piper (Jan 2025).

**CPA s11 opt-out registry**
- National Consumer Commission regulations have applied since 15 April 2026.
- The CPA protects juristic persons with turnover under R2m. That covers many of Kopano's SME customers.
- Marketers must suppress contacts that are on the registry.
- Source: GoLegal (2026).

**WhatsApp Business Platform**
- Business-initiated messages outside a 24-hour window must use pre-approved templates.
- An opt-in must name the business.
- SA pricing: marketing about US$0.038 (about R0.62) per message, utility about US$0.008 (about R0.12). A "your contract ends on…" notice is a *utility* message; an upgrade offer is *marketing*.
- Low quality ratings trigger rate limits.
- Source: Meta developer docs.

**Discarded as not relevant here**
- Generic "omnichannel increases conversion by X%" vendor statistics. They assume a reachable, consented base, which Kopano doesn't have.

## 4. Insights

- **I1. The ask is blocked before it starts.** *(F2, F3, F4)* Automated outreach needs contact points. About 90% of the accounts in the renewal window have none, and the 10% that do are mostly unverified. Automating outreach would reach about 22 accounts, which agents could phone in an afternoon.
- **I2. The leak is in the conversation, not the dial.** *(F6, F7, F8)* Half of all calls connect, so dialling isn't the constraint. The collapse is from connected to opportunity (8.8%), and no follow-up is recorded anywhere. Opportunities die between calls, not on them.
- **I3. Contact data is held hostage by the incentive scheme.** *(F2, F10)* The scarcest asset, a verified decision-maker contact, sits in personal sheets because sharing it can cost an agent commission. No tool fixes that. The incentive has to change.
- **I4. The compliance exposure is concentrated exactly where the client wants to automate.** *(F11, F12, research)* Here are three facts together:
  - the s69(3) basis depends on data ownership, which is unclear
  - opt-outs can't be matched by account
  - the sender has already been warned once

  Put together, a bulk WhatsApp launch is the single most likely way to lose the channel altogether.
- **I5. The status column can't drive a renewal queue.** *(F5, H07)* Eligibility has to come from the end date plus price-plan rules, not from a snapshot status.

## 5. Spiky POVs

**SPOV 1: Kopano doesn't have a reach problem. It has an unreachable base. Automating channels now would make things worse, not better.**

- **Evidence:** I1, I4.
- **Strongest counter-argument:** "Even 10% reached by WhatsApp beats 0%, and WhatsApp open rates are far higher than calls."
- **Why it loses here:**
  - 10% of the renewal window is 22 accounts. That doesn't need automation.
  - Each untargeted message risks a complaint against a sender that has already been warned.
  - Automation scales whatever you feed it. Feed it this base and it scales errors.

**SPOV 2: A mandatory, dated next action will add more upgrades than any new channel.**

- **Evidence:** I2.
- **Strongest counter-argument:** "Low conversion means the leads are poor (customers aren't interested), so follow-up won't help."
- **Why it loses for now:** 8 of 10 quote requests have no next step recorded. Interested customers are being dropped, not just uninterested ones.
- **Kill condition:** in section 7.

**SPOV 3: Pay agents for capturing contacts, not just for upgrades.**

- **Evidence:** I3.
- **Strongest counter-argument:** "Changing commission causes resentment, so build a better tool and agents will adopt it."
- **Why it loses:** the tool can't capture data that agents are motivated to withhold. Make upgrade commission conditional on the customer's decision-maker contact and opt-out status being recorded in the shared record. That turns a cost into a habit.

## 6. Solution

**Fix first (weeks 1–2)**
- One customer record. Match on Account No + normalised name, and request company reg. numbers from the Network.
- Merge agent sheets into shared contact points. Normalise numbers to E.164 and flag landlines.
- Match the legal opt-out list to customers.
- Ask the Network for written confirmation of the s69(3) basis.

**Build (weeks 2–6): the Renewal Desk**
- A 90-day queue computed from end date + plan rules.
- A customer view.
- Outcome logging that **cannot be saved** without a dated next action.
- A manager exceptions view: overdue callbacks, no valid contact, quotes with no next step.

**Process changes**
- **Contact capture rule:** every connected call confirms the decision-maker's contact details and offers an opt-out.
- **Commission rule:** per SPOV 3.

**Phase 2 (gate: ≥60% of renewal-window accounts contactable, plus the s69(3) basis confirmed in writing, plus templates approved)**
- WhatsApp/SMS **utility** template "your contract ends on [date]", with an opt-out in every message.
- **Marketing** offers only to customers who have opted in.
- Projected cost: 224 accounts × 2 messages × about R0.12 ≈ **R55 a month**. Cost is not the constraint. Consent and contactability are.

**Don't build**
- A bulk campaign tool.
- A management dashboard. Lerato: "I don't need another dashboard."
- Real-time dialler integration (there's no API). Load the nightly CSV later if needed.

## 7. Success criteria

| Metric | Baseline | Target | By | Proves me wrong if… |
|---|---|---|---|---|
| Renewal-window accounts with a verified, consented contact | 10% (22/224) | 60% | Week 6 | Below 30% at week 6 with the capture rule enforced. Contacts then have to come from the Network, so re-scope |
| Interactions with a dated next action | 0% | 95% | Day 30 | n/a (process measure) |
| Connected → opportunity | 8.8% | 15% | Day 60 | **SPOV 2 is wrong** if next-action compliance stays ≥90% for 4 weeks and conversion stays below 10%. The leak is then the offer or lead quality, so the focus moves to pricing and offers |
| Upgrades per month (VSAM) | 22 (Sept) | 44 (Lerato's target) | Day 90 | Below 30 at day 90 means the Phase 2 gate decision needs revisiting |
| Complaints / sender warnings | 1 warning last year | 0 | Ongoing | Any warning pauses Phase 2 |

## 8. AI-use note

AI was used for:
- profiling the sheets: counts, cross-sheet joins, date-format detection
- a first-pass summary of the POPIA and WhatsApp sources, which I then checked against the originals

I did the following myself:
- the interview strategy
- connecting the incentive scheme to the missing contact data
- the POVs
- the kill conditions

---

## Appendix A: Gap log (excerpt; the full log maps to D01–D23)

| Gap | Evidence | Blocks | Severity | Fix |
|---|---|---|---|---|
| No customer key; line grain | 5,114 lines / 1,377 accounts; no reg. no. | One view per customer | Critical | Customer table keyed on reg. no. (request from Network) + Account No; fuzzy name match for the 7 duplicate pairs |
| No contact channels in base | 0 contact columns; 9% of accounts in agent sheet | All outreach | Critical | Contact-points table; capture rule; agent-sheet merge |
| Phone numbers unusable | Leading zeros lost, `0` placeholders (17), landlines mixed in | SMS/WhatsApp | Critical | E.164 normalisation; landline flag; validation on capture |
| No consent/opt-out linkage | Legal list by name only (H04); no flag in base | Lawful marketing (s69) | Critical | Match the list; per-contact consent status; opt-out in every message; CPA registry suppression |
| No next action | `Next Action` 100% empty; 9 undated callbacks | Follow-up; conversion | Critical | Mandatory dated next action on every outcome |
| Stale status | 107 expired lines marked InContract | Renewal queue accuracy | High | Derive status from end date |
| Date chaos | `2026/13/08`, ambiguous `08/12/2026` | Activity history | High | Ordered parsing; quarantine ambiguous dates |
| Dialler data is aggregate only | No per-call records; no API | Call-level attribution | High | Log outcomes in the Desk; nightly CSV for totals |
| Fractions turned into dates | `3/4` → 4 March | Activity reporting | Medium | Store as text/integers |

## Appendix B: Open questions

1. **Network account manager:** written s69(3) basis; reg. numbers; whether a contact field can be added to the export.
2. **Legal:** account numbers for the opt-out list; details of last year's complaint.
3. **Finance/HR:** feasibility of the commission change.
4. **Lerato:** which price plans have the 1-month upgrade rule.
