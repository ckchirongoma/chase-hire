import type { RubricDefinition } from "./types";
import { execCommsSubs, spikyPovSubs } from "./shared";

/**
 * BA Part 1: discovery, gaps and Spiky POV (docs/06, docs/09 §3–4, docs/13).
 * Gold-answer figures are {{tokens}} filled from the bundle's internal/answer_key.json at
 * grading time, so the judge never sees numbers from another bundle (or the real workbook).
 */

export const GAP_KEY = [
  { id: "D01", gap: "No customer-level key; the base is at line grain (MSISDN); \"customer\" = account no., with no company reg. number", severity: "Critical", weight: 3 },
  { id: "D02", gap: "No contact channels (phone, email, WhatsApp) in the base. Only about {{worksheet_account_pct}} of accounts have any contact data, held in the agent sheet", severity: "Critical", weight: 3 },
  { id: "D03", gap: "Same company under multiple accounts; name variants", severity: "High", weight: 2 },
  { id: "D04", gap: "Agent-sheet accounts missing from the base", severity: "Medium", weight: 1 },
  { id: "D05", gap: "Phone formats inconsistent: leading zero stripped, `0` placeholders, landlines mixed in. Not E.164; can't be used for WhatsApp/SMS", severity: "Critical", weight: 3 },
  { id: "D06", gap: "Account holder name `0` (blank stored as zero); emails missing", severity: "High", weight: 2 },
  { id: "D07", gap: "Mixed types in the contact column", severity: "Low", weight: 1 },
  { id: "D08", gap: "`date contacted` in mixed and impossible formats (US, ambiguous, YYYY/DD/MM, month 13)", severity: "High", weight: 2 },
  { id: "D09", gap: "Fractions auto-converted to dates (`3/4` → 4 March)", severity: "Medium", weight: 1 },
  { id: "D10", gap: "Epoch placeholder end dates (1970-01-01)", severity: "Medium", weight: 1 },
  { id: "D11", gap: "Status contradicts end date: \"InContract\" lines that have already expired", severity: "High", weight: 2 },
  { id: "D12", gap: "\"Months remaining\" is a text bucket, so it can't drive a 90-day rule", severity: "Medium", weight: 1 },
  { id: "D13", gap: "Free-text outcomes, a headerless notes column, a bolted-on \"clean\" column", severity: "Medium", weight: 1 },
  { id: "D14", gap: "Next Action / Action Required 100% empty; callbacks with no date", severity: "Critical", weight: 3 },
  { id: "D15", gap: "Quote requests don't flow to applications; no pipeline linkage", severity: "High", weight: 2 },
  { id: "D16", gap: "Meaningless status field (\"DONE\" on everything)", severity: "Low", weight: 1 },
  { id: "D17", gap: "Hand-maintained counts drift from the base", severity: "Medium", weight: 1 },
  { id: "D18", gap: "Constant columns; misspelt manager name", severity: "Low", weight: 1 },
  { id: "D19", gap: "Telephony is aggregate only: no per-call, customer or timestamp data; no API", severity: "High", weight: 2 },
  { id: "D20", gap: "Agent identity not reconciled across systems; test/system users present", severity: "Medium", weight: 1 },
  { id: "D21", gap: "Activity log issues: packed target string, trailing-space headers, booked-off days counted as zero", severity: "Low", weight: 1 },
  { id: "D22", gap: "Funnel: the conversion collapse is between connected and opportunity, so this is a process problem, not only a tooling problem", severity: "High", weight: 2 },
  { id: "D23", gap: "No consent / opt-out flag in the base; POPIA s69 basis unclear", severity: "Critical", weight: 3 },
] as const;

export const HIDDEN_FACTS = [
  { id: "H01", fact: "Customer contact details live in the agents' own sheets; the base from the Network doesn't have them.", weight: 3 },
  { id: "H02", fact: "The base is a monthly Power BI export from the Network; its columns can't be changed.", weight: 2 },
  { id: "H03", fact: "The customer data is technically the Network's; the dealer agreement allows contact about Network products, renewals and upgrades.", weight: 3 },
  { id: "H04", fact: "Legal keeps an opt-out and 'under legal review' list in a separate spreadsheet, by company name, not account number.", weight: 3 },
  { id: "H05", fact: "The dialler has no API; a nightly CSV export is possible.", weight: 2 },
  { id: "H06", fact: "The WhatsApp/SMS platform is the Network's; templates need their approval (about a week last time).", weight: 2 },
  { id: "H07", fact: "Upgrades open three months before contract end, but a few price plans only allow it in the last month.", weight: 2 },
  { id: "H08", fact: "Agents earn commission per upgrade, so they don't love sharing their sheets.", weight: 2 },
  { id: "H09", fact: "The contract status column is whatever it was on the day the Network ran the report.", weight: 2 },
  { id: "H10", fact: "One account manager owns the entire base; if he's on leave, nothing moves.", weight: 1 },
  { id: "H11", fact: "A bulk SMS blast last year drew complaints and the Network threatened to suspend the sender.", weight: 3 },
  { id: "H12", fact: "The target is to double upgrades per month; she doesn't need another dashboard.", weight: 1 },
  { id: "H13", fact: "Half the time the contact person is a bookkeeper or receptionist, not the decision maker.", weight: 2 },
  { id: "H14", fact: "Lines that port out vanish from the next month's base; nobody tells them.", weight: 2 },
] as const;

const GOLD = {
  source:
    "docs/13 reference Spiky POV (calibration anchor, highest-scoring gold sample). {{figure}} tokens are replaced with this bundle's answer_key.json figures at grading time; score reasoning and evidence, not closeness to these numbers.",
  executive_summary: `**Don't automate outreach yet. First make the renewal base reachable, and make every conversation end in a dated next step.**
- Of the {{window_accounts}} accounts whose contracts end in the next 90 days, about {{window_no_contact_pct}} have no phone number or email anywhere in the data.
- The team connects on about half its calls ({{funnel_connect_rate_pct}}), but fewer than 1 in 10 connected calls becomes an opportunity ({{funnel_opp_rate_pct}}).
- WhatsApp would reach almost nobody, and the people it did reach might not have consented. After last year's SMS complaints, that risks the sender account.
Recommendation: a 6-week Renewal Desk (one customer record, verified contacts with consent status, a 90-day renewal queue, mandatory callback dates), then switch on WhatsApp/SMS for contactable, consented customers.
Decision needed: approve the contact-capture rule and the commission change; ask the Network account manager to confirm in writing that these customers may be contacted about renewals.`,
  facts: `F1 The base has {{base_lines}} rows, one per line (MSISDN), across {{base_accounts}} account numbers; no company registration number and no customer ID beyond Account No.
F2 The base has no phone, email or WhatsApp field. Contact details exist only in one agent's working sheet, for {{worksheet_accounts}} accounts ({{worksheet_account_pct}}).
F3 In that sheet, {{holder_zero}} of {{worksheet_accounts}} rows have 0 as the account-holder name, {{email_blank}} have no email, and {{contact_zero}} have 0 as the phone number; many numbers lost their leading zero.
F4 {{window_lines}} lines across {{window_accounts}} accounts reach contract end in the next 90 days, carrying {{window_charges_zar}} a month in charges. Only {{window_accounts_in_worksheet}} of those accounts ({{window_accounts_in_worksheet_pct}}) appear in the agent sheet.
F5 {{incontract_expired}} lines are "InContract" although their end date has passed; the status column is "whatever it was on the day the Network ran the report" (H09).
F6 Next Action and Action Required are 100% empty; {{callbacks_no_date}} rows are "Call back / Follow up" with no date anywhere.
F7 Of {{quote_rows}} customers who asked for a quote, 1 is processing and 1 is approved; the other {{quotes_without_next_step}} have no recorded next step.
F8 September, 4 agents: {{funnel_calls}} calls → {{funnel_connected}} connected ({{funnel_connect_rate_pct}}) → {{funnel_opportunities}} opportunities ({{funnel_opp_rate_pct}} of connected) → {{funnel_sales}} sales, against a target of 6 per agent per day (about {{target_sales_month}} a month): about {{sales_pct_of_target}} of target.
F9 The dialler reports only agent-level totals; no per-call records and no API, only a nightly CSV (H05).
F10–F12 Contacts sit in agents' own sheets (H01) and commission discourages sharing (H08); opt-outs are a legal spreadsheet keyed by company name (H04) and last year's bulk SMS drew complaints and a sender warning (H11); the data is technically the Network's under the dealer agreement (H03).`,
  insights: `I1 The ask is blocked before it starts (F2, F3, F4): about {{window_no_contact_pct}} of renewal-window accounts have no contact point, and the rest are mostly unverified; automating would reach about {{window_accounts_in_worksheet}} accounts, which agents could phone in an afternoon.
I2 The leak is in the conversation, not the dial (F6, F7, F8): half of calls connect; the collapse is connected → opportunity and no follow-up is recorded. Opportunities die between calls.
I3 Contact data is held hostage by the incentive scheme (F2, F10): the scarcest asset sits in personal sheets because sharing can cost commission. No tool fixes that; the incentive has to change.
I4 The compliance exposure is concentrated where the client wants to automate (F11, F12, research): s69(3) depends on unclear data ownership, opt-outs can't be matched by account, and the sender has been warned once.
I5 The status column can't drive a renewal queue (F5, H07): eligibility must come from end date plus price-plan rules.`,
  spiky_povs: `SPOV 1: Kopano doesn't have a reach problem; it has an unreachable base. Automating channels now would make things worse. Evidence I1, I4. Strongest counter: "Even {{window_accounts_in_worksheet_pct}} reached by WhatsApp beats 0%, and open rates beat calls." Why it loses here: {{window_accounts_in_worksheet_pct}} of the window is about {{window_accounts_in_worksheet}} accounts (no automation needed); every untargeted message risks a complaint against an already-warned sender; automation scales whatever you feed it.
SPOV 2: A mandatory, dated next action will add more upgrades than any new channel. Evidence I2. Counter: "Low conversion means poor leads, so follow-up won't help." Why it loses for now: {{quotes_without_next_step}} of {{quote_rows}} quote requests have no next step; interested customers are being dropped. Kill condition in the success criteria.
SPOV 3: Pay agents for capturing contacts, not just for upgrades. Evidence I3. Counter: "Changing commission causes resentment; build a better tool." Why it loses: a tool can't capture data agents are motivated to withhold; make upgrade commission conditional on the decision-maker contact and opt-out status being recorded.`,
  solution: `Fix first (weeks 1–2): one customer record (Account No + normalised name; request reg. numbers), merge agent sheets into shared contact points normalised to E.164 with landlines flagged, match the legal opt-out list, get the s69(3) basis confirmed in writing.
Build (weeks 2–6): the Renewal Desk: 90-day queue from end date + plan rules, customer view, outcome logging that cannot be saved without a dated next action, manager exceptions view.
Process: contact-capture rule on every connected call; commission rule per SPOV 3.
Phase 2 gate (≥60% of window accounts contactable + s69(3) basis confirmed + templates approved): utility template "your contract ends on [date]" with opt-out; marketing only to opted-in customers; cost about {{window_accounts}} accounts × 2 messages × ~R0.12 ≈ {{phase2_utility_cost_zar}} a month. Cost is not the constraint; consent and contactability are.
Don't build: a bulk campaign tool, a management dashboard ("I don't need another dashboard"), or real-time dialler integration (no API).`,
  success_criteria: `| Metric | Baseline | Target | By | Proves me wrong if… |
| Renewal-window accounts with a verified, consented contact | {{window_contactable_pct}} | 60% | Week 6 | Below 30% at week 6 with the capture rule enforced: contacts must come from the Network, re-scope |
| Interactions with a dated next action | 0% | 95% | Day 30 | n/a (process measure) |
| Connected → opportunity | {{funnel_opp_rate_pct}} | 15% | Day 60 | SPOV 2 is wrong if next-action compliance stays ≥90% for 4 weeks and conversion stays below 10% |
| Upgrades per month | {{funnel_sales}} (Sept) | double (Lerato's target) | Day 90 | Well short at day 90 means revisiting the Phase 2 gate |
| Complaints / sender warnings | 1 warning last year | 0 | Ongoing | Any warning pauses Phase 2 |`,
  research: `POPIA s69: electronic direct marketing is opt-in by default; the s69(3) exception covers your own customers for similar products if an opt-out was offered at collection and in every message. Renewals fit "similar products", but "your own customers" is what H03 puts in doubt. The Information Regulator's guidance brings telemarketing calls within direct marketing.
CPA s11 opt-out registry: suppression applies; the CPA protects juristic persons under R2m turnover, which covers many SME customers.
WhatsApp Business Platform: business-initiated messages outside 24 hours need pre-approved templates; opt-in must name the business; utility vs marketing categories price differently (a contract-end notice is utility, an upgrade offer is marketing); low quality ratings trigger limits.
Discarded: generic "omnichannel lifts conversion by X%" vendor statistics, because they assume a reachable, consented base.`,
};

export const BA_PART1: RubricDefinition = {
  key: "ba_part1",
  version: 1,
  title: "BA Part 1: discovery, gaps and Spiky POV",
  criteria: [
    {
      key: "gap_recall",
      title: "Gap recall",
      weight: 25,
      method: "computed",
      computation: "gap_recall",
      prompt: "gap-recall-grader",
      evidence_required: true,
      sources: ["memo"],
      reference_keys: ["gap_key", "bundle_evidence"],
      description:
        "Weighted recall of the D01–D23 gap key from the memo's facts, insights and Appendix A gap log. Found = identified with evidence that matches this bundle; partial = mentioned with wrong or missing evidence. The platform scores 1 + 4 × Σ(weight × {found 1, partial 0.5}) ÷ 40, taking the per-gap median across 3 samples. Gaps outside the key go to extra_valid_gaps for a human.",
      anchors: {
        "1": "Little or nothing from the key (recall near 0): generic data-quality remarks; none of the critical blockers (D01, D02, D05, D14, D23) evidenced",
        "3": "About half of the weighted key (about 20 of 40 points), including most critical gaps, with some sheet/column/count evidence",
        "5": "Nearly the full key (36+ of 40 points): every critical and high gap identified with counts that match the data",
      },
    },
    {
      key: "elicitation",
      title: "Elicitation",
      weight: 20,
      method: "mixed",
      evidence_required: false,
      description: "50% elicitation yield (weighted hidden facts revealed in the stakeholder chat, computed) + 50% quality of questioning (judged from the transcript).",
      anchors: {
        "1": "Few or no hidden facts revealed and vague or leading questions",
        "3": "About half the weighted facts, with some targeted questions on data and consent",
        "5": "Nearly all weighted facts, including every critical one, through funnelled, non-leading questions that confirm understanding and challenge the WhatsApp assumption",
      },
      subcriteria: [
        {
          key: "yield",
          title: "Elicitation yield",
          weight: 1,
          method: "computed",
          computation: "elicitation_yield",
          evidence_required: false,
          description: "Weighted share of hidden facts H01–H14 the persona revealed (persona_sessions.revealed_fact_ids): 1 + 4 × points ÷ 30.",
          anchors: {
            "1": "No hidden facts revealed (0 of 30 points)",
            "3": "About half the weighted facts (about 15 of 30), including at least one critical fact (H01, H03, H04 or H11)",
            "5": "All or nearly all weighted facts (27+ of 30), including every critical fact",
          },
        },
        {
          key: "quality",
          title: "Question quality",
          weight: 1,
          method: "llm",
          prompt: "elicitation-grader",
          evidence_required: true,
          sources: ["transcript"],
          reference_keys: ["hidden_facts"],
          description:
            "Quality of questioning in the stakeholder chat: broad then funnelled; data sources, ownership, consent, history and incentives covered; understanding confirmed back; the WhatsApp assumption challenged with evidence; no leading questions. Yield is computed separately: do not score it here.",
          anchors: {
            "1": "Vague or leading questions (\"any challenges?\"); no funnel; never asks about data sources, ownership, consent, history or incentives; accepts the WhatsApp assumption",
            "3": "Some targeted questions on data or consent, partly funnelled; little confirming back; challenges the WhatsApp idea weakly or without evidence",
            "5": "Opens broad then funnels; covers data source, ownership and legal basis, consent and opt-outs, past attempts and incentives; confirms understanding back; challenges the WhatsApp assumption with evidence; no leading questions",
          },
        },
      ],
    },
    {
      key: "spiky_pov",
      title: "Spiky POV quality",
      weight: 25,
      method: "llm",
      evidence_required: true,
      description: "Mean of the seven Spiky POV sub-criteria P1–P7 (docs/09 §3).",
      anchors: {
        "1": "Consensus restated without evidence, counter-argument or action",
        "3": "Contestable positions loosely tied to facts, with weak steelmanning and some hedging",
        "5": "1–3 distinct, debatable, evidenced positions with a steelman, quantified impact and a solution that follows directly",
      },
      subcriteria: spikyPovSubs(),
    },
    {
      key: "success_criteria",
      title: "Success criteria",
      weight: 10,
      method: "llm",
      prompt: "grader-criterion",
      evidence_required: true,
      sources: ["memo"],
      reference_keys: ["gold_success_criteria", "bundle_figures"],
      description: "Measurability of the success criteria: metric, baseline from the data, target, timeframe and the result that would prove the candidate wrong.",
      anchors: {
        "1": "No measurable criteria, or outputs only (\"launch WhatsApp\"); no baselines, targets or kill condition",
        "3": "Metrics with targets and timeframes, but baselines missing or not taken from the data, and no result that would prove the POV wrong",
        "5": "Every criterion has a metric, a baseline computed from the data (e.g. contactable share, connected → opportunity rate), a target, a timeframe and an explicit kill/falsification condition tied to a POV",
      },
    },
    {
      key: "research",
      title: "Research quality and relevance",
      weight: 10,
      method: "llm",
      prompt: "grader-criterion",
      evidence_required: true,
      sources: ["memo"],
      reference_keys: ["gold_research"],
      description:
        "External research (POPIA s69, WhatsApp rules, CPA opt-out registry, benchmarks): sourced, current, filtered for relevance and applied to this client.",
      anchors: {
        "1": "No external research, or unsourced generic claims (e.g. vendor \"omnichannel lifts conversion\" statistics)",
        "3": "Relevant sources cited (e.g. POPIA s69, WhatsApp template rules) but summarised without applying them to this client, or mixed with irrelevant material",
        "5": "Sourced, current and filtered: POPIA s69(3) and its own-customer condition tied to the data-ownership fact, CPA opt-out suppression, WhatsApp template category and pricing applied to this case; irrelevant material explicitly discarded",
      },
    },
    {
      key: "exec_comms",
      title: "Executive communication (memo)",
      weight: 10,
      method: "llm",
      evidence_required: true,
      description: "Mean of E1–E6 (docs/09 §4) on the written memo.",
      anchors: {
        "1": "Recommendation buried, topic list, assertions only, no ask",
        "3": "Recommendation early but hedged, grouped points, some numbers, an ask without trade-offs",
        "5": "Answer first, MECE support, quantified and sourced, explicit decision with trade-offs, every paragraph earns its place",
      },
      subcriteria: execCommsSubs(["E1", "E2", "E3", "E4", "E5", "E6"], { artefact: "memo", sources: ["memo"], audience: "Lerato, the client GM" }),
    },
  ],
  reference: {
    gap_key: { total: 40, note: "Weights sum to 40 (docs/06 says 39; the table sums to 40).", items: GAP_KEY },
    hidden_facts: { total: 30, persona_key: "lerato", items: HIDDEN_FACTS },
    great_looks_like:
      "The ask (automated omnichannel outreach) is blocked by D01 + D02 + D05 + D23 + H03 + H04 + H11: automating outreach to an uncontactable, consent-unclear base risks the sender account and the dealer agreement. A great memo reframes the problem as contactability + next-action discipline first, channels second.",
    gold_executive_summary: GOLD.executive_summary,
    gold_facts: GOLD.facts,
    gold_insights: GOLD.insights,
    gold_spiky_povs: GOLD.spiky_povs,
    gold_solution: GOLD.solution,
    gold_success_criteria: GOLD.success_criteria,
    gold_research: GOLD.research,
    gold_source: GOLD.source,
  },
};
