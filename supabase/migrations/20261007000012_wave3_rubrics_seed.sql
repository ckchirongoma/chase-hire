-- Wave 3: work-assessment rubrics (version 1) and human overrides on submission grades.
-- Re-runnable: rubrics upsert on (key, version) and keep any generic_baseline already generated;
-- functions are create-or-replace and triggers are dropped and recreated.
--
-- 1. Rubrics ba_part1, ba_part2, swe_test1, swe_test2 (docs/06, 07, 08, 09). criteria JSON:
--    [{key, title, weight, description, anchors {"1","3","5"}, evidence_required,
--      method 'llm'|'computed'|'mixed', prompt?, computation?, sources?, reference_keys?,
--      baseline?, human_check?, subcriteria?: [same shape]}]
--    Subcriteria are graded under "<criterion>.<sub>" keys. reference JSON holds the answer keys
--    (D-codes total 40: docs/06 says 39 but its table sums to 40; hidden facts 30; F-codes 21;
--    A-codes 32), the red flags with their caps, tokenised docs/13 gold excerpts (figures come
--    from the bundle's answer_key.json at grading time) and the internal SWE2 reference price.
--    The rubric block below is rendered from lib/grading/rubrics (tests/unit/rubrics checks it).
--    rubrics stay admin-SELECT only (migration 0008), so candidates never see a key.
--
-- 2. Human overrides on 'submission' summaries (grade_summaries.human_score, reason >= 20 chars
--    enforced by the table): final_score is ALWAYS coalesce(human_score, median_score) for
--    submission rows (a direct final_score write cannot bypass the scored + reasoned override),
--    and a human score clears the review flag; a sub-criterion ("parent.sub") change recomputes
--    its parent (weighted mean of the sub finals, null while any weighted sub has none, any
--    red-flag cap kept in the parent's computed grade row, largest spread, review if any sub
--    still needs it); a top-level change recomputes submissions.score (same formula as
--    lib/grading stageScore: null while any weighted criterion has no final score) and
--    grading_status. Nothing here touches applications.status. The interview override trigger
--    (0009) is unchanged.

insert into public.rubrics (key, version, title, criteria, reference, active) values (
  'ba_part1', 1, 'BA Part 1: discovery, gaps and Spiky POV',
  $criteria_ba_part1$[
  {
    "key": "gap_recall",
    "title": "Gap recall",
    "weight": 25,
    "method": "computed",
    "computation": "gap_recall",
    "prompt": "gap-recall-grader",
    "evidence_required": true,
    "sources": [
      "memo"
    ],
    "reference_keys": [
      "gap_key",
      "bundle_evidence"
    ],
    "description": "Weighted recall of the D01–D23 gap key from the memo's facts, insights and Appendix A gap log. Found = identified with evidence that matches this bundle; partial = mentioned with wrong or missing evidence. The platform scores 1 + 4 × Σ(weight × {found 1, partial 0.5}) ÷ 40, taking the per-gap median across 3 samples. Gaps outside the key go to extra_valid_gaps for a human.",
    "anchors": {
      "1": "Little or nothing from the key (recall near 0): generic data-quality remarks; none of the critical blockers (D01, D02, D05, D14, D23) evidenced",
      "3": "About half of the weighted key (about 20 of 40 points), including most critical gaps, with some sheet/column/count evidence",
      "5": "Nearly the full key (36+ of 40 points): every critical and high gap identified with counts that match the data"
    }
  },
  {
    "key": "elicitation",
    "title": "Elicitation",
    "weight": 20,
    "method": "mixed",
    "evidence_required": false,
    "description": "50% elicitation yield (weighted hidden facts revealed in the stakeholder chat, computed) + 50% quality of questioning (judged from the transcript).",
    "anchors": {
      "1": "Few or no hidden facts revealed and vague or leading questions",
      "3": "About half the weighted facts, with some targeted questions on data and consent",
      "5": "Nearly all weighted facts, including every critical one, through funnelled, non-leading questions that confirm understanding and challenge the WhatsApp assumption"
    },
    "subcriteria": [
      {
        "key": "yield",
        "title": "Elicitation yield",
        "weight": 1,
        "method": "computed",
        "computation": "elicitation_yield",
        "evidence_required": false,
        "description": "Weighted share of hidden facts H01–H14 the persona revealed (persona_sessions.revealed_fact_ids): 1 + 4 × points ÷ 30.",
        "anchors": {
          "1": "No hidden facts revealed (0 of 30 points)",
          "3": "About half the weighted facts (about 15 of 30), including at least one critical fact (H01, H03, H04 or H11)",
          "5": "All or nearly all weighted facts (27+ of 30), including every critical fact"
        }
      },
      {
        "key": "quality",
        "title": "Question quality",
        "weight": 1,
        "method": "llm",
        "prompt": "elicitation-grader",
        "evidence_required": true,
        "sources": [
          "transcript"
        ],
        "reference_keys": [
          "hidden_facts"
        ],
        "description": "Quality of questioning in the stakeholder chat: broad then funnelled; data sources, ownership, consent, history and incentives covered; understanding confirmed back; the WhatsApp assumption challenged with evidence; no leading questions. Yield is computed separately: do not score it here.",
        "anchors": {
          "1": "Vague or leading questions (\"any challenges?\"); no funnel; never asks about data sources, ownership, consent, history or incentives; accepts the WhatsApp assumption",
          "3": "Some targeted questions on data or consent, partly funnelled; little confirming back; challenges the WhatsApp idea weakly or without evidence",
          "5": "Opens broad then funnels; covers data source, ownership and legal basis, consent and opt-outs, past attempts and incentives; confirms understanding back; challenges the WhatsApp assumption with evidence; no leading questions"
        }
      }
    ]
  },
  {
    "key": "spiky_pov",
    "title": "Spiky POV quality",
    "weight": 25,
    "method": "llm",
    "evidence_required": true,
    "description": "Mean of the seven Spiky POV sub-criteria P1–P7 (docs/09 §3).",
    "anchors": {
      "1": "Consensus restated without evidence, counter-argument or action",
      "3": "Contestable positions loosely tied to facts, with weak steelmanning and some hedging",
      "5": "1–3 distinct, debatable, evidenced positions with a steelman, quantified impact and a solution that follows directly"
    },
    "subcriteria": [
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Whether each POV is a position a reasonable expert could argue against, and whether the candidate states that opposite.",
        "prompt": "grader-criterion",
        "key": "p1",
        "title": "P1 Debatable",
        "anchors": {
          "1": "Consensus restated (\"data quality matters\")",
          "3": "Mildly contestable",
          "5": "A reasonable expert could argue the opposite, and the candidate states that opposite"
        },
        "sources": [
          "memo"
        ],
        "reference_keys": [
          "gold_spiky_povs",
          "gold_insights"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Whether each POV rests on insights that are tied to cited facts (sheet/column/interview/source).",
        "prompt": "grader-criterion",
        "key": "p2",
        "title": "P2 Traceable",
        "anchors": {
          "1": "No link to facts",
          "3": "Linked to one fact or source",
          "5": "Each POV rests on 2+ insights, each tied to cited facts (sheet/column/interview/source)"
        },
        "sources": [
          "memo"
        ],
        "reference_keys": [
          "gold_spiky_povs",
          "gold_insights",
          "bundle_figures"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Whether the POV reframes the problem beyond what the client said or a default AI answer says. A POV that substantially matches GENERIC_BASELINE scores at most 2.",
        "prompt": "grader-criterion",
        "key": "p3",
        "title": "P3 Non-obvious",
        "anchors": {
          "1": "What the client already said, or what a default LLM answer says",
          "3": "Some reframing",
          "5": "Reframes the problem in a way the client hadn't seen. Fails the \"would ChatGPT say this unprompted?\" test"
        },
        "sources": [
          "memo"
        ],
        "reference_keys": [
          "gold_spiky_povs",
          "gold_insights"
        ],
        "baseline": "required"
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Whether the strongest counter-position is stated and shown to lose here, for this client.",
        "prompt": "grader-criterion",
        "key": "p4",
        "title": "P4 Steelman",
        "anchors": {
          "1": "No counter-argument",
          "3": "A weak counter-argument",
          "5": "States the strongest counter-position and why it loses *here*"
        },
        "sources": [
          "memo"
        ],
        "reference_keys": [
          "gold_spiky_povs",
          "gold_insights"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Whether the POV is tied to money, sales or time using the client's own numbers (compare with BUNDLE FIGURES).",
        "prompt": "grader-criterion",
        "key": "p5",
        "title": "P5 Business-tied",
        "anchors": {
          "1": "No link to money, sales or time",
          "3": "Qualitative impact",
          "5": "Quantified impact in rands, sales or hours, using the client's own numbers"
        },
        "sources": [
          "memo"
        ],
        "reference_keys": [
          "gold_spiky_povs",
          "gold_insights",
          "bundle_figures"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Whether the proposed solution follows directly from the POV, including what not to build.",
        "prompt": "grader-criterion",
        "key": "p6",
        "title": "P6 Actionable",
        "anchors": {
          "1": "The solution doesn't follow from the POV",
          "3": "Loosely follows",
          "5": "The solution is a direct consequence, including what *not* to build"
        },
        "sources": [
          "memo"
        ],
        "reference_keys": [
          "gold_spiky_povs",
          "gold_insights",
          "gold_solution"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Assertiveness and scoping of the POVs; overlap between them.",
        "prompt": "grader-criterion",
        "key": "p7",
        "title": "P7 Precise",
        "anchors": {
          "1": "Hedged (\"might\", \"could\"); many overlapping POVs",
          "3": "Some hedging",
          "5": "Assertive, scoped (\"except when…\"), 1–3 distinct POVs"
        },
        "sources": [
          "memo"
        ],
        "reference_keys": [
          "gold_spiky_povs",
          "gold_insights"
        ]
      }
    ]
  },
  {
    "key": "success_criteria",
    "title": "Success criteria",
    "weight": 10,
    "method": "llm",
    "prompt": "grader-criterion",
    "evidence_required": true,
    "sources": [
      "memo"
    ],
    "reference_keys": [
      "gold_success_criteria",
      "bundle_figures"
    ],
    "description": "Measurability of the success criteria: metric, baseline from the data, target, timeframe and the result that would prove the candidate wrong.",
    "anchors": {
      "1": "No measurable criteria, or outputs only (\"launch WhatsApp\"); no baselines, targets or kill condition",
      "3": "Metrics with targets and timeframes, but baselines missing or not taken from the data, and no result that would prove the POV wrong",
      "5": "Every criterion has a metric, a baseline computed from the data (e.g. contactable share, connected → opportunity rate), a target, a timeframe and an explicit kill/falsification condition tied to a POV"
    }
  },
  {
    "key": "research",
    "title": "Research quality and relevance",
    "weight": 10,
    "method": "llm",
    "prompt": "grader-criterion",
    "evidence_required": true,
    "sources": [
      "memo"
    ],
    "reference_keys": [
      "gold_research"
    ],
    "description": "External research (POPIA s69, WhatsApp rules, CPA opt-out registry, benchmarks): sourced, current, filtered for relevance and applied to this client.",
    "anchors": {
      "1": "No external research, or unsourced generic claims (e.g. vendor \"omnichannel lifts conversion\" statistics)",
      "3": "Relevant sources cited (e.g. POPIA s69, WhatsApp template rules) but summarised without applying them to this client, or mixed with irrelevant material",
      "5": "Sourced, current and filtered: POPIA s69(3) and its own-customer condition tied to the data-ownership fact, CPA opt-out suppression, WhatsApp template category and pricing applied to this case; irrelevant material explicitly discarded"
    }
  },
  {
    "key": "exec_comms",
    "title": "Executive communication (memo)",
    "weight": 10,
    "method": "llm",
    "evidence_required": true,
    "description": "Mean of E1–E6 (docs/09 §4) on the written memo.",
    "anchors": {
      "1": "Recommendation buried, topic list, assertions only, no ask",
      "3": "Recommendation early but hedged, grouped points, some numbers, an ask without trade-offs",
      "5": "Answer first, MECE support, quantified and sourced, explicit decision with trade-offs, every paragraph earns its place"
    },
    "subcriteria": [
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E1 (docs/09 §4) in the memo, judged as Lerato, the client GM would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "e1",
        "title": "E1 Answer first (memo)",
        "anchors": {
          "1": "Recommendation buried or missing",
          "3": "In the first paragraph, but hedged",
          "5": "Recommendation/ask in the first two sentences"
        },
        "sources": [
          "memo"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E2 (docs/09 §4) in the memo, judged as Lerato, the client GM would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "e2",
        "title": "E2 Pyramid logic (memo)",
        "anchors": {
          "1": "A list of topics or a chronology",
          "3": "Grouped, but overlapping",
          "5": "3–5 MECE supporting points, each a claim that summarises its evidence"
        },
        "sources": [
          "memo"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E3 (docs/09 §4) in the memo, judged as Lerato, the client GM would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "e3",
        "title": "E3 SCQA framing (memo)",
        "anchors": {
          "1": "No context, or too much",
          "3": "Context given, but the decision question is implicit",
          "5": "Situation + complication in 3 sentences or fewer; decision question explicit"
        },
        "sources": [
          "memo"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E4 (docs/09 §4) in the memo, judged as Lerato, the client GM would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "e4",
        "title": "E4 Evidence (memo)",
        "anchors": {
          "1": "Assertions only",
          "3": "Some numbers",
          "5": "Key claims quantified and sourced; assumptions stated"
        },
        "sources": [
          "memo"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E5 (docs/09 §4) in the memo, judged as Lerato, the client GM would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "e5",
        "title": "E5 Decision readiness (memo)",
        "anchors": {
          "1": "No ask",
          "3": "Ask without trade-offs",
          "5": "Options with trade-offs, risks, the specific ask, next steps with owners"
        },
        "sources": [
          "memo"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E6 (docs/09 §4) in the memo, judged as Lerato, the client GM would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "e6",
        "title": "E6 Economy (memo)",
        "anchors": {
          "1": "Over the limit, or padded",
          "3": "Within the limit, some padding",
          "5": "Within the limit; every paragraph earns its place"
        },
        "sources": [
          "memo"
        ]
      }
    ]
  }
]$criteria_ba_part1$::jsonb,
  $reference_ba_part1${
  "gap_key": {
    "total": 40,
    "note": "Weights sum to 40 (docs/06 says 39; the table sums to 40).",
    "items": [
      {
        "id": "D01",
        "gap": "No customer-level key; the base is at line grain (MSISDN); \"customer\" = account no., with no company reg. number",
        "severity": "Critical",
        "weight": 3
      },
      {
        "id": "D02",
        "gap": "No contact channels (phone, email, WhatsApp) in the base. Only about {{worksheet_account_pct}} of accounts have any contact data, held in the agent sheet",
        "severity": "Critical",
        "weight": 3
      },
      {
        "id": "D03",
        "gap": "Same company under multiple accounts; name variants",
        "severity": "High",
        "weight": 2
      },
      {
        "id": "D04",
        "gap": "Agent-sheet accounts missing from the base",
        "severity": "Medium",
        "weight": 1
      },
      {
        "id": "D05",
        "gap": "Phone formats inconsistent: leading zero stripped, `0` placeholders, landlines mixed in. Not E.164; can't be used for WhatsApp/SMS",
        "severity": "Critical",
        "weight": 3
      },
      {
        "id": "D06",
        "gap": "Account holder name `0` (blank stored as zero); emails missing",
        "severity": "High",
        "weight": 2
      },
      {
        "id": "D07",
        "gap": "Mixed types in the contact column",
        "severity": "Low",
        "weight": 1
      },
      {
        "id": "D08",
        "gap": "`date contacted` in mixed and impossible formats (US, ambiguous, YYYY/DD/MM, month 13)",
        "severity": "High",
        "weight": 2
      },
      {
        "id": "D09",
        "gap": "Fractions auto-converted to dates (`3/4` → 4 March)",
        "severity": "Medium",
        "weight": 1
      },
      {
        "id": "D10",
        "gap": "Epoch placeholder end dates (1970-01-01)",
        "severity": "Medium",
        "weight": 1
      },
      {
        "id": "D11",
        "gap": "Status contradicts end date: \"InContract\" lines that have already expired",
        "severity": "High",
        "weight": 2
      },
      {
        "id": "D12",
        "gap": "\"Months remaining\" is a text bucket, so it can't drive a 90-day rule",
        "severity": "Medium",
        "weight": 1
      },
      {
        "id": "D13",
        "gap": "Free-text outcomes, a headerless notes column, a bolted-on \"clean\" column",
        "severity": "Medium",
        "weight": 1
      },
      {
        "id": "D14",
        "gap": "Next Action / Action Required 100% empty; callbacks with no date",
        "severity": "Critical",
        "weight": 3
      },
      {
        "id": "D15",
        "gap": "Quote requests don't flow to applications; no pipeline linkage",
        "severity": "High",
        "weight": 2
      },
      {
        "id": "D16",
        "gap": "Meaningless status field (\"DONE\" on everything)",
        "severity": "Low",
        "weight": 1
      },
      {
        "id": "D17",
        "gap": "Hand-maintained counts drift from the base",
        "severity": "Medium",
        "weight": 1
      },
      {
        "id": "D18",
        "gap": "Constant columns; misspelt manager name",
        "severity": "Low",
        "weight": 1
      },
      {
        "id": "D19",
        "gap": "Telephony is aggregate only: no per-call, customer or timestamp data; no API",
        "severity": "High",
        "weight": 2
      },
      {
        "id": "D20",
        "gap": "Agent identity not reconciled across systems; test/system users present",
        "severity": "Medium",
        "weight": 1
      },
      {
        "id": "D21",
        "gap": "Activity log issues: packed target string, trailing-space headers, booked-off days counted as zero",
        "severity": "Low",
        "weight": 1
      },
      {
        "id": "D22",
        "gap": "Funnel: the conversion collapse is between connected and opportunity, so this is a process problem, not only a tooling problem",
        "severity": "High",
        "weight": 2
      },
      {
        "id": "D23",
        "gap": "No consent / opt-out flag in the base; POPIA s69 basis unclear",
        "severity": "Critical",
        "weight": 3
      }
    ]
  },
  "hidden_facts": {
    "total": 30,
    "persona_key": "lerato",
    "items": [
      {
        "id": "H01",
        "fact": "Customer contact details live in the agents' own sheets; the base from the Network doesn't have them.",
        "weight": 3
      },
      {
        "id": "H02",
        "fact": "The base is a monthly Power BI export from the Network; its columns can't be changed.",
        "weight": 2
      },
      {
        "id": "H03",
        "fact": "The customer data is technically the Network's; the dealer agreement allows contact about Network products, renewals and upgrades.",
        "weight": 3
      },
      {
        "id": "H04",
        "fact": "Legal keeps an opt-out and 'under legal review' list in a separate spreadsheet, by company name, not account number.",
        "weight": 3
      },
      {
        "id": "H05",
        "fact": "The dialler has no API; a nightly CSV export is possible.",
        "weight": 2
      },
      {
        "id": "H06",
        "fact": "The WhatsApp/SMS platform is the Network's; templates need their approval (about a week last time).",
        "weight": 2
      },
      {
        "id": "H07",
        "fact": "Upgrades open three months before contract end, but a few price plans only allow it in the last month.",
        "weight": 2
      },
      {
        "id": "H08",
        "fact": "Agents earn commission per upgrade, so they don't love sharing their sheets.",
        "weight": 2
      },
      {
        "id": "H09",
        "fact": "The contract status column is whatever it was on the day the Network ran the report.",
        "weight": 2
      },
      {
        "id": "H10",
        "fact": "One account manager owns the entire base; if he's on leave, nothing moves.",
        "weight": 1
      },
      {
        "id": "H11",
        "fact": "A bulk SMS blast last year drew complaints and the Network threatened to suspend the sender.",
        "weight": 3
      },
      {
        "id": "H12",
        "fact": "The target is to double upgrades per month; she doesn't need another dashboard.",
        "weight": 1
      },
      {
        "id": "H13",
        "fact": "Half the time the contact person is a bookkeeper or receptionist, not the decision maker.",
        "weight": 2
      },
      {
        "id": "H14",
        "fact": "Lines that port out vanish from the next month's base; nobody tells them.",
        "weight": 2
      }
    ]
  },
  "great_looks_like": "The ask (automated omnichannel outreach) is blocked by D01 + D02 + D05 + D23 + H03 + H04 + H11: automating outreach to an uncontactable, consent-unclear base risks the sender account and the dealer agreement. A great memo reframes the problem as contactability + next-action discipline first, channels second.",
  "gold_executive_summary": "**Don't automate outreach yet. First make the renewal base reachable, and make every conversation end in a dated next step.**\n- Of the {{window_accounts}} accounts whose contracts end in the next 90 days, about {{window_no_contact_pct}} have no phone number or email anywhere in the data.\n- The team connects on about half its calls ({{funnel_connect_rate_pct}}), but fewer than 1 in 10 connected calls becomes an opportunity ({{funnel_opp_rate_pct}}).\n- WhatsApp would reach almost nobody, and the people it did reach might not have consented. After last year's SMS complaints, that risks the sender account.\nRecommendation: a 6-week Renewal Desk (one customer record, verified contacts with consent status, a 90-day renewal queue, mandatory callback dates), then switch on WhatsApp/SMS for contactable, consented customers.\nDecision needed: approve the contact-capture rule and the commission change; ask the Network account manager to confirm in writing that these customers may be contacted about renewals.",
  "gold_facts": "F1 The base has {{base_lines}} rows, one per line (MSISDN), across {{base_accounts}} account numbers; no company registration number and no customer ID beyond Account No.\nF2 The base has no phone, email or WhatsApp field. Contact details exist only in one agent's working sheet, for {{worksheet_accounts}} accounts ({{worksheet_account_pct}}).\nF3 In that sheet, {{holder_zero}} of {{worksheet_accounts}} rows have 0 as the account-holder name, {{email_blank}} have no email, and {{contact_zero}} have 0 as the phone number; many numbers lost their leading zero.\nF4 {{window_lines}} lines across {{window_accounts}} accounts reach contract end in the next 90 days, carrying {{window_charges_zar}} a month in charges. Only {{window_accounts_in_worksheet}} of those accounts ({{window_accounts_in_worksheet_pct}}) appear in the agent sheet.\nF5 {{incontract_expired}} lines are \"InContract\" although their end date has passed; the status column is \"whatever it was on the day the Network ran the report\" (H09).\nF6 Next Action and Action Required are 100% empty; {{callbacks_no_date}} rows are \"Call back / Follow up\" with no date anywhere.\nF7 Of {{quote_rows}} customers who asked for a quote, 1 is processing and 1 is approved; the other {{quotes_without_next_step}} have no recorded next step.\nF8 September, 4 agents: {{funnel_calls}} calls → {{funnel_connected}} connected ({{funnel_connect_rate_pct}}) → {{funnel_opportunities}} opportunities ({{funnel_opp_rate_pct}} of connected) → {{funnel_sales}} sales, against a target of 6 per agent per day (about {{target_sales_month}} a month): about {{sales_pct_of_target}} of target.\nF9 The dialler reports only agent-level totals; no per-call records and no API, only a nightly CSV (H05).\nF10–F12 Contacts sit in agents' own sheets (H01) and commission discourages sharing (H08); opt-outs are a legal spreadsheet keyed by company name (H04) and last year's bulk SMS drew complaints and a sender warning (H11); the data is technically the Network's under the dealer agreement (H03).",
  "gold_insights": "I1 The ask is blocked before it starts (F2, F3, F4): about {{window_no_contact_pct}} of renewal-window accounts have no contact point, and the rest are mostly unverified; automating would reach about {{window_accounts_in_worksheet}} accounts, which agents could phone in an afternoon.\nI2 The leak is in the conversation, not the dial (F6, F7, F8): half of calls connect; the collapse is connected → opportunity and no follow-up is recorded. Opportunities die between calls.\nI3 Contact data is held hostage by the incentive scheme (F2, F10): the scarcest asset sits in personal sheets because sharing can cost commission. No tool fixes that; the incentive has to change.\nI4 The compliance exposure is concentrated where the client wants to automate (F11, F12, research): s69(3) depends on unclear data ownership, opt-outs can't be matched by account, and the sender has been warned once.\nI5 The status column can't drive a renewal queue (F5, H07): eligibility must come from end date plus price-plan rules.",
  "gold_spiky_povs": "SPOV 1: Kopano doesn't have a reach problem; it has an unreachable base. Automating channels now would make things worse. Evidence I1, I4. Strongest counter: \"Even {{window_accounts_in_worksheet_pct}} reached by WhatsApp beats 0%, and open rates beat calls.\" Why it loses here: {{window_accounts_in_worksheet_pct}} of the window is about {{window_accounts_in_worksheet}} accounts (no automation needed); every untargeted message risks a complaint against an already-warned sender; automation scales whatever you feed it.\nSPOV 2: A mandatory, dated next action will add more upgrades than any new channel. Evidence I2. Counter: \"Low conversion means poor leads, so follow-up won't help.\" Why it loses for now: {{quotes_without_next_step}} of {{quote_rows}} quote requests have no next step; interested customers are being dropped. Kill condition in the success criteria.\nSPOV 3: Pay agents for capturing contacts, not just for upgrades. Evidence I3. Counter: \"Changing commission causes resentment; build a better tool.\" Why it loses: a tool can't capture data agents are motivated to withhold; make upgrade commission conditional on the decision-maker contact and opt-out status being recorded.",
  "gold_solution": "Fix first (weeks 1–2): one customer record (Account No + normalised name; request reg. numbers), merge agent sheets into shared contact points normalised to E.164 with landlines flagged, match the legal opt-out list, get the s69(3) basis confirmed in writing.\nBuild (weeks 2–6): the Renewal Desk: 90-day queue from end date + plan rules, customer view, outcome logging that cannot be saved without a dated next action, manager exceptions view.\nProcess: contact-capture rule on every connected call; commission rule per SPOV 3.\nPhase 2 gate (≥60% of window accounts contactable + s69(3) basis confirmed + templates approved): utility template \"your contract ends on [date]\" with opt-out; marketing only to opted-in customers; cost about {{window_accounts}} accounts × 2 messages × ~R0.12 ≈ {{phase2_utility_cost_zar}} a month. Cost is not the constraint; consent and contactability are.\nDon't build: a bulk campaign tool, a management dashboard (\"I don't need another dashboard\"), or real-time dialler integration (no API).",
  "gold_success_criteria": "| Metric | Baseline | Target | By | Proves me wrong if… |\n| Renewal-window accounts with a verified, consented contact | {{window_contactable_pct}} | 60% | Week 6 | Below 30% at week 6 with the capture rule enforced: contacts must come from the Network, re-scope |\n| Interactions with a dated next action | 0% | 95% | Day 30 | n/a (process measure) |\n| Connected → opportunity | {{funnel_opp_rate_pct}} | 15% | Day 60 | SPOV 2 is wrong if next-action compliance stays ≥90% for 4 weeks and conversion stays below 10% |\n| Upgrades per month | {{funnel_sales}} (Sept) | double (Lerato's target) | Day 90 | Well short at day 90 means revisiting the Phase 2 gate |\n| Complaints / sender warnings | 1 warning last year | 0 | Ongoing | Any warning pauses Phase 2 |",
  "gold_research": "POPIA s69: electronic direct marketing is opt-in by default; the s69(3) exception covers your own customers for similar products if an opt-out was offered at collection and in every message. Renewals fit \"similar products\", but \"your own customers\" is what H03 puts in doubt. The Information Regulator's guidance brings telemarketing calls within direct marketing.\nCPA s11 opt-out registry: suppression applies; the CPA protects juristic persons under R2m turnover, which covers many SME customers.\nWhatsApp Business Platform: business-initiated messages outside 24 hours need pre-approved templates; opt-in must name the business; utility vs marketing categories price differently (a contract-end notice is utility, an upgrade offer is marketing); low quality ratings trigger limits.\nDiscarded: generic \"omnichannel lifts conversion by X%\" vendor statistics, because they assume a reachable, consented base.",
  "gold_source": "docs/13 reference Spiky POV (calibration anchor, highest-scoring gold sample). {{figure}} tokens are replaced with this bundle's answer_key.json figures at grading time; score reasoning and evidence, not closeness to these numbers."
}$reference_ba_part1$::jsonb,
  true)
on conflict (key, version) do update
  set title = excluded.title, criteria = excluded.criteria, reference = excluded.reference;

insert into public.rubrics (key, version, title, criteria, reference, active) values (
  'ba_part2', 1, 'BA Part 2: build and handoff',
  $criteria_ba_part2$[
  {
    "key": "data_model",
    "title": "Data model correctness",
    "weight": 25,
    "method": "llm",
    "prompt": "grader-criterion",
    "evidence_required": true,
    "sources": [
      "handoff"
    ],
    "reference_keys": [
      "data_model_expectations"
    ],
    "description": "ERD, table definitions and one-sentence grain per table: grain, keys, consent modelled per contact point, history as events, no line/customer confusion.",
    "anchors": {
      "1": "No ERD or table definitions, or the model confuses line and customer grain; consent stored per customer or not at all; interactions overwrite state",
      "3": "ERD and definitions with mostly correct grain and keys, but gaps: consent not per contact point, history kept as a status field, or customer → account → line relations partly wrong",
      "5": "Grain stated for every table; customer → account → line with correct keys and the MSISDN never used as the customer; consent and verification per contact point; interactions and next actions as append-only events; eligibility derived from the end date, not the stale export status"
    }
  },
  {
    "key": "mvp",
    "title": "MVP functionality",
    "weight": 25,
    "method": "llm",
    "prompt": "grader-criterion",
    "evidence_required": true,
    "sources": [
      "mvp",
      "loom"
    ],
    "reference_keys": [
      "required_features"
    ],
    "human_check": "Rubric requires a human click-through of the hosted MVP (docs/06: automated click-through plus human check)",
    "description": "The hosted MVP running on the provided data, judged from the snapshot of the MVP URL and the Loom demo, against the five required features.",
    "anchors": {
      "1": "No working hosted MVP, or it does not run on the provided data; most required features missing",
      "3": "Hosted and running on the data; 3–4 of the 5 required features work, but rules are UI-only or partial (callback date optional, messaging not blocked for opted-out customers)",
      "5": "All five features work on the provided data: prioritised 90-day queue with eligibility rules, customer 360 with consent, outcome logging that cannot save \"Call back\" without a date, template messaging blocked without consent or after opt-out (queued, not sent), and the manager exceptions view"
    }
  },
  {
    "key": "handoff",
    "title": "Handoff quality",
    "weight": 30,
    "method": "llm",
    "prompt": "grader-criterion",
    "evidence_required": true,
    "sources": [
      "handoff"
    ],
    "reference_keys": [
      "handoff_sections",
      "business_rules",
      "required_features"
    ],
    "description": "Testable acceptance criteria, rules, access matrix, edge cases. The test: could the engineer build it without asking?",
    "anchors": {
      "1": "The engineer would have to ask about most things: stories without acceptance criteria, rules missing, no access matrix",
      "3": "Stories with some Given/When/Then ACs and the main rules, but untestable or missing ACs for key flows, a partial access matrix, few edge cases or non-functional needs",
      "5": "Buildable without asking: testable Given/When/Then ACs for every story; eligibility, consent, allocation and dedupe rules stated precisely; a complete role × action matrix (agent, manager, admin); edge cases, non-functional needs, out of scope and open questions"
    }
  },
  {
    "key": "exec_comms_loom",
    "title": "Executive communication (Loom to Lerato)",
    "weight": 10,
    "method": "llm",
    "evidence_required": true,
    "description": "Mean of E1, E3, E5 and E8 (docs/09 §4) on the Loom transcript, addressed to Lerato.",
    "anchors": {
      "1": "No clear point or ask; technical walkthrough aimed at engineers",
      "3": "Recommendation stated but hedged; an ask without trade-offs; partly translated for an executive",
      "5": "Answer first, situation and decision framed in a few sentences, a specific ask with trade-offs, technical detail turned into business impact"
    },
    "subcriteria": [
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E1 (docs/09 §4) in the Loom, judged as Lerato, the client GM would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "e1",
        "title": "E1 Answer first (Loom)",
        "anchors": {
          "1": "Recommendation buried or missing",
          "3": "In the first paragraph, but hedged",
          "5": "Recommendation/ask in the first two sentences"
        },
        "sources": [
          "loom"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E3 (docs/09 §4) in the Loom, judged as Lerato, the client GM would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "e3",
        "title": "E3 SCQA framing (Loom)",
        "anchors": {
          "1": "No context, or too much",
          "3": "Context given, but the decision question is implicit",
          "5": "Situation + complication in 3 sentences or fewer; decision question explicit"
        },
        "sources": [
          "loom"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E5 (docs/09 §4) in the Loom, judged as Lerato, the client GM would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "e5",
        "title": "E5 Decision readiness (Loom)",
        "anchors": {
          "1": "No ask",
          "3": "Ask without trade-offs",
          "5": "Options with trade-offs, risks, the specific ask, next steps with owners"
        },
        "sources": [
          "loom"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E8 (docs/09 §4) in the Loom, judged as Lerato, the client GM would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "e8",
        "title": "E8 Audience calibration (Loom)",
        "anchors": {
          "1": "Jargon to an exec",
          "3": "Partly translated",
          "5": "Turns technical detail into business impact without being prompted"
        },
        "sources": [
          "loom"
        ]
      }
    ]
  },
  {
    "key": "judgement",
    "title": "Judgement: what was left out and why",
    "weight": 10,
    "method": "llm",
    "prompt": "grader-criterion",
    "evidence_required": true,
    "sources": [
      "handoff",
      "loom"
    ],
    "reference_keys": [
      "solution_brief"
    ],
    "description": "The handoff's out-of-scope list and the Loom: what the candidate deliberately did not build, and whether the reasons follow from the brief and the data.",
    "anchors": {
      "1": "No out-of-scope list, or builds what the Solution Brief excludes (bulk outreach, dashboards, dialler integration) without saying why",
      "3": "Lists what was left out, with thin reasons not tied to the brief or the data",
      "5": "Explicit, reasoned cuts tied to the Solution Brief and the data (e.g. no bulk outreach until contactable share passes 60%, no real sending, no dialler integration without an API), and says what would change the decision"
    }
  }
]$criteria_ba_part2$::jsonb,
  $reference_ba_part2${
  "solution_brief": "# Solution Brief: Kopano Renewal Desk\n\n**Agreed direction:** fix contactability and next-action discipline before automating channels. Phase 1 is a Renewal Desk:\n\n- one customer record\n- verified contact points with a consent status\n- a 90-day renewal queue\n- mandatory dated next actions\n- template messaging only to consented, contactable customers\n- a manager exceptions view\n\nBulk outreach is out of scope until the contactable share passes 60%.\n",
  "required_features": [
    "Renewal queue: lines and customers entering the 90-day window, prioritised, with eligibility rules applied (three months before end date; one month for last-month-only plans)",
    "Customer 360: accounts, lines, contact points with consent status, interaction history",
    "Log outcome: a callback date is REQUIRED for \"Call back\"; quote, sale and not-interested outcomes available",
    "Message: compose from an approved template, blocked if there is no consent or the customer has opted out; queued, not actually sent",
    "Manager exceptions view: missing next actions, overdue callbacks, customers with no valid contact point"
  ],
  "data_model_expectations": [
    "customers (one row per company; reg_no; normalised_name) → accounts (dealer account numbers; many per customer) → lines (one per MSISDN in E.164; end date, plan, monthly charge in rands)",
    "Line status derived from contract_end_date, not the export's stale status; eligible_from = end date − 3 months, or − 1 month for last-month-only plans",
    "contact_points per customer with type, value, role (decision maker / admin), verified_at, consent_status (opted_in / existing_customer_s69_3 / opted_out / unknown) and source",
    "interactions as append-only events with outcome and next_action_at; a callback without a date is impossible",
    "Opt-outs matched to customers (the legal list is by company name) and enforced before any message is queued",
    "Agents, managers and admins as users with roles; allocation of customers or lines to agents"
  ],
  "handoff_sections": [
    "The problem and the POV in 5 lines",
    "User stories with Given/When/Then acceptance criteria",
    "Business rules: eligibility, consent, allocation, deduplication",
    "Access matrix: role × action (agent, manager, admin)",
    "Edge cases",
    "Non-functional needs",
    "Out of scope",
    "Open questions"
  ],
  "business_rules": [
    "Eligibility: from three months before contract end; some price plans only in the last month",
    "Consent: message only verified contact points with opted_in or existing_customer_s69_3 status, never opted_out; opt-out offered in every message",
    "A \"Call back\" outcome requires a dated next action; every interaction ends in a dated next step",
    "Deduplication: one customer across several accounts and name variants (reg no where present, normalised name otherwise)",
    "Bulk outreach out of scope until the contactable share passes 60%"
  ]
}$reference_ba_part2$::jsonb,
  true)
on conflict (key, version) do update
  set title = excluded.title, criteria = excluded.criteria, reference = excluded.reference;

insert into public.rubrics (key, version, title, criteria, reference, active) values (
  'swe_test1', 1, 'SWE Test 1: harden and ship',
  $criteria_swe_test1$[
  {
    "key": "s1_fault_discovery",
    "title": "S1 Fault discovery and fix",
    "weight": 30,
    "method": "computed",
    "computation": "fault_points",
    "prompt": "answer-key-grader",
    "evidence_required": true,
    "sources": [
      "readme"
    ],
    "reference_keys": [
      "fault_key"
    ],
    "description": "F01–F14 found and properly fixed, weighted (security F01–F06 and F13 weight 2, the rest 1; max 21), mapped from the README's found/fixed list: found = found and properly fixed with a correct explanation; partial = found but not fixed, fix incomplete, or explanation wrong. Harness results confirm or downgrade fixes when present. Includes S7 security posture (U2–U5, R1–R2). Points map to the anchors linearly in between.",
    "anchors": {
      "1": "< 6 points of 21",
      "3": "10–14 points",
      "5": "≥ 18 points, with correct explanations"
    }
  },
  {
    "key": "s2_import",
    "title": "S2 Monthly import",
    "weight": 25,
    "method": "computed",
    "computation": "harness_import",
    "prompt": "grader-criterion",
    "evidence_required": true,
    "sources": [
      "readme",
      "harness"
    ],
    "reference_keys": [
      "harness_checks",
      "month2_expectations"
    ],
    "description": "Scored from the month-2 harness (M1–M7) when it has run. Without harness results the judge reads the README's account of the import and the score needs a human (review reason: harness not run).",
    "anchors": {
      "1": "Fails M1 or M6: re-running duplicates customers or changes data; history does not survive a month",
      "3": "Passes M1–M3 and M6: idempotent, customers not duplicated, changed lines updated in place",
      "5": "Passes all M1–M7 with a clear quarantine report: removed lines kept as ported/inactive, and a schema drift fails loudly with no partial data"
    }
  },
  {
    "key": "s3_stories",
    "title": "S3 Stories RD-07 and RD-11",
    "weight": 10,
    "method": "computed",
    "computation": "harness_stories",
    "prompt": "grader-criterion",
    "evidence_required": true,
    "sources": [
      "readme",
      "harness"
    ],
    "reference_keys": [
      "harness_checks",
      "stories"
    ],
    "description": "RD-07 (mandatory callback date) and RD-11 (opt-out enforcement) against their ACs: harness U6/U7 plus tests (R5); README-based judgement when the harness has not run.",
    "anchors": {
      "1": "Neither story enforced server-side (UI-only checks, or not implemented)",
      "3": "One story enforced at the DB/API level",
      "5": "Both enforced at the DB/API level, with tests"
    }
  },
  {
    "key": "s4_deploy_ops",
    "title": "S4 Deployment and ops",
    "weight": 15,
    "method": "computed",
    "computation": "harness_deploy",
    "prompt": "grader-criterion",
    "evidence_required": true,
    "sources": [
      "readme",
      "harness"
    ],
    "reference_keys": [
      "harness_checks"
    ],
    "description": "R4–R7, U1, CI, monitoring and resourceful hosting; README-based judgement when the harness has not run.",
    "anchors": {
      "1": "Not deployed, or broken",
      "3": "Deployed; some ops basics (builds, env handled, partial CI or tests)",
      "5": "Deployed; CI green; health check; error monitoring; rollback note"
    }
  },
  {
    "key": "s9_communication",
    "title": "S9 Communication",
    "weight": 20,
    "method": "llm",
    "prompt": "grader-criterion",
    "evidence_required": true,
    "sources": [
      "readme",
      "release_notes",
      "adr",
      "loom"
    ],
    "reference_keys": [
      "communication_expectations"
    ],
    "description": "README found/fixed and didn't-do lists, ADR-001, the release note written for Lerato, and the Loom.",
    "anchors": {
      "1": "Unclear, or missing",
      "3": "Clear but technical",
      "5": "The release note is understandable to an exec; the ADR shows real trade-offs; the \"didn't do\" list shows prioritisation"
    }
  }
]$criteria_swe_test1$::jsonb,
  $reference_swe_test1${
  "fault_key": {
    "total": 21,
    "note": "Security faults F01–F06 and F13 weigh 2; the rest 1.",
    "items": [
      {
        "id": "F01",
        "fault": "customers table has RLS disabled",
        "category": "Security",
        "weight": 2,
        "detection": "Harness RLS probe + advisor",
        "harness": [
          "R3",
          "U3"
        ]
      },
      {
        "id": "F02",
        "fault": "interactions has RLS with policy using (true) for authenticated: any agent sees every agent's interactions",
        "category": "Security",
        "weight": 2,
        "detection": "Cross-tenant probe",
        "harness": [
          "U4"
        ]
      },
      {
        "id": "F03",
        "fault": "Default anon grants on lines plus a permissive select policy for anon added \"for the demo\"",
        "category": "Security",
        "weight": 2,
        "detection": "Unauthenticated REST probe",
        "harness": [
          "U3"
        ]
      },
      {
        "id": "F04",
        "fault": "Service-role key in NEXT_PUBLIC_SUPABASE_SERVICE_KEY, used in one client component",
        "category": "Security",
        "weight": 2,
        "detection": "Bundle scan",
        "harness": [
          "R2",
          "U2"
        ]
      },
      {
        "id": "F05",
        "fault": "/api/summary (OpenRouter) has no auth, no rate limit and no max tokens",
        "category": "Cost/abuse",
        "weight": 2,
        "detection": "Burst probe (expect 401/429)",
        "harness": [
          "U5"
        ]
      },
      {
        "id": "F06",
        "fault": "User text interpolated straight into the AI prompt with other customers' data (prompt-injection / data-leak path)",
        "category": "Security",
        "weight": 2,
        "detection": "Human review + injection probe",
        "harness": []
      },
      {
        "id": "F07",
        "fault": "No migrations: schema created by hand, schema.sql out of date",
        "category": "Ops",
        "weight": 1,
        "detection": "supabase/migrations/ + db reset",
        "harness": [
          "R3"
        ]
      },
      {
        "id": "F08",
        "fault": "Import deletes all rows then inserts: customer IDs change monthly and interaction history is orphaned",
        "category": "Data",
        "weight": 1,
        "detection": "Month-2 harness",
        "harness": [
          "M1",
          "M2",
          "M6"
        ]
      },
      {
        "id": "F09",
        "fault": "Phone numbers stored as numbers (leading zero lost)",
        "category": "Data",
        "weight": 1,
        "detection": "Data check after import (D-a)",
        "harness": [
          "D-a"
        ]
      },
      {
        "id": "F10",
        "fault": "\"Call back\" saves without a callback date (UI-only validation)",
        "category": "Correctness",
        "weight": 1,
        "detection": "API probe",
        "harness": [
          "U6"
        ]
      },
      {
        "id": "F11",
        "fault": "Contract status read from the stale export column instead of derived from the end date",
        "category": "Correctness",
        "weight": 1,
        "detection": "Data check (D-b)",
        "harness": [
          "D-b"
        ]
      },
      {
        "id": "F12",
        "fault": "Opt-out list not applied to messaging",
        "category": "Compliance",
        "weight": 1,
        "detection": "Data check: an opted-out customer can be messaged",
        "harness": [
          "U7"
        ]
      },
      {
        "id": "F13",
        "fault": ".env.local committed early and later deleted: the secret is still in history",
        "category": "Security",
        "weight": 2,
        "detection": "gitleaks",
        "harness": [
          "R1"
        ]
      },
      {
        "id": "F14",
        "fault": "No error handling on the import: a bad row crashes the run silently, leaving a partial import",
        "category": "Ops",
        "weight": 1,
        "detection": "Month-2 harness",
        "harness": [
          "M5",
          "M7"
        ]
      }
    ]
  },
  "harness_checks": {
    "R1": "gitleaks over full history: the F13 secret is gone from history or the README documents the key rotation (ideal: both)",
    "R2": "No service_role / SERVICE / sb_secret_ in NEXT_PUBLIC_* or 'use client' files",
    "R3": "supabase/migrations/ exists and applies cleanly; every table has RLS",
    "R4": "npm ci && lint && tsc --noEmit && build exit 0",
    "R5": "Tests exist and pass: at least one covers the import and one covers RD-07",
    "R6": ".github/workflows exists and the last run on the SHA is green",
    "R7": ".env* gitignored and .env.example exists",
    "U1": "GET /api/health returns 200 and touches the DB",
    "U2": "Bundle scan: no service-role JWT, no secret key in HTML/JS",
    "U3": "Unauthenticated REST probe on customers, lines, interactions: empty or rejected",
    "U4": "Cross-tenant: agent A cannot read agent B's interactions/allocations",
    "U5": "AI route burst: 401 unauthenticated; 429 within the burst (or a documented per-user cap) authenticated",
    "U6": "RD-07: POST call_back without a date via the API is rejected (4xx)",
    "U7": "RD-11: queueing a message to an opted-out customer (matched by name) is blocked",
    "U8": "Security headers grade (informational)",
    "M1": "Customer count increases only by the true number of new customers",
    "M2": "Sentinel customers' interaction history intact (same IDs)",
    "M3": "Changed lines updated, not duplicated",
    "M4": "Removed lines marked inactive/ported, not deleted",
    "M5": "Quarantine report lists the ambiguous and invalid rows, with reasons",
    "M6": "Re-uploading the same month-2 file changes nothing",
    "M7": "Drift file (renamed + added column) fails loudly naming the column, with no partial data",
    "D-a": "Phones stored as E.164 text; landlines distinguished from mobiles",
    "D-b": "Contract status derived from the end date",
    "D-c": "Epoch dates null or quarantined"
  },
  "month2_expectations": "base_month2.xlsx: 4% of lines changed, 2% new (15 for existing customers), 1.5% removed (ported), 30 duplicate rows, 20 new phone-format spellings of existing numbers, 10 ambiguous dates. base_month2_drift.xlsx renames Contract End Date → Contract_End and adds Sales_Rep. Exact counts: datasets/<version>/bundle_c/internal/expected_month2.json.",
  "stories": {
    "RD-07": "Mandatory callback date: a Call back outcome cannot be saved without a date, enforced by the DB or API, not only the UI.",
    "RD-11": "Opt-out enforcement: the legal list is matched to customers (by company name, with variants) and no message can be queued to an opted-out customer."
  },
  "communication_expectations": [
    "README: architecture, how to run, decisions, what was found and fixed, and what was deliberately not done",
    "RELEASE_NOTES.md: half a page for Lerato (client GM): what changed for her team, in business terms",
    "docs/ADR-001.md: one real choice, the options, and why",
    "Loom: the three most important changes"
  ]
}$reference_swe_test1$::jsonb,
  true)
on conflict (key, version) do update
  set title = excluded.title, criteria = excluded.criteria, reference = excluded.reference;

insert into public.rubrics (key, version, title, criteria, reference, active) values (
  'swe_test2', 1, 'SWE Test 2: architecture, costing and security',
  $criteria_swe_test2$[
  {
    "key": "answer_key",
    "title": "Answer-key coverage",
    "weight": 35,
    "method": "computed",
    "computation": "answer_key",
    "prompt": "answer-key-grader",
    "evidence_required": true,
    "sources": [
      "memo",
      "loom"
    ],
    "reference_keys": [
      "answer_key",
      "red_flags"
    ],
    "baseline": "optional",
    "description": "Weighted coverage of A01–A15 (max 32) from the memo and Loom, with red-flag caps: a crawler zeroes A02, uploading masters without security zeroes A07, accepting automatic takedowns zeroes A04 and caps executive communication at 3, an unsourced precise vendor price halves A11. Score = 1 + 4 × coverage; a red flag counts when 2 of 3 samples report it.",
    "anchors": {
      "1": "Covers almost none of A01–A15, or red flags zero the critical items",
      "3": "About half of the weighted key (about 16 of 32), including at least two of the critical judgements A01–A04",
      "5": "Nearly the full key (29+ of 32) with no red flags: no second Content ID presence, registries and vendors instead of crawling, build only where vendors don't reach, human-confirmed takedowns"
    }
  },
  {
    "key": "cost_model",
    "title": "Cost model quality",
    "weight": 20,
    "method": "llm",
    "prompt": "grader-criterion",
    "evidence_required": true,
    "sources": [
      "memo"
    ],
    "reference_keys": [
      "cost_expectations"
    ],
    "description": "Drivers, assumptions, sensitivity, rand conversion, and honesty about unknown vendor prices.",
    "anchors": {
      "1": "No cost model, or a single number without drivers or assumptions; invented vendor precision; no rand conversion",
      "3": "Build and run costs with some drivers and assumptions and a partial USD → ZAR conversion; little sensitivity analysis; the R15k/month budget tested only loosely",
      "5": "Build effort and monthly run cost in rands broken into drivers (scanning, re-querying, vendor fees, people), assumptions stated, USD → ZAR shown with the rate, sensitivity on what moves the number, honest about quote-only vendors, and the R15k/month budget tested explicitly"
    }
  },
  {
    "key": "security_maintenance",
    "title": "Security and maintenance depth",
    "weight": 10,
    "method": "llm",
    "prompt": "grader-criterion",
    "evidence_required": true,
    "sources": [
      "memo"
    ],
    "reference_keys": [
      "security_expectations"
    ],
    "description": "Protection of unreleased masters and the evidence trail; what breaks over time, who watches it, and its cost.",
    "anchors": {
      "1": "No security plan for unreleased masters or the evidence trail; maintenance not mentioned",
      "3": "Some controls (encryption, access control) and a maintenance list, but masters may leave the environment, or maintenance is costed as infrastructure only",
      "5": "Masters never leave the label's environment (local fingerprinting, hashes not audio), KMS + least privilege + access logs, a chain-of-custody evidence package; maintenance costed as people-time (API/policy changes, vendor renewals, threshold tuning, false-positive review)"
    }
  },
  {
    "key": "phasing_kill",
    "title": "Phasing and kill criteria",
    "weight": 10,
    "method": "llm",
    "prompt": "grader-criterion",
    "evidence_required": true,
    "sources": [
      "memo"
    ],
    "reference_keys": [
      "phasing_expectations"
    ],
    "description": "Phases with exit criteria and at least one kill criterion that would stop or redirect the project.",
    "anchors": {
      "1": "No phases, or phases with no exit criteria and no kill criterion",
      "3": "Phases with some exit criteria but no measurable kill criterion, or the fingerprint-DB dependency ignored",
      "5": "Phases with measurable exit criteria, Phase 0 on the 40%-done fingerprint database, a quick win on Stage, and at least one measurable kill criterion (e.g. stop sample detection if precision at the agreed recall stays below X after N weeks)"
    }
  },
  {
    "key": "exec_comms",
    "title": "Executive communication (memo + Loom to the CEO)",
    "weight": 25,
    "method": "llm",
    "evidence_required": true,
    "description": "Mean of memo E1–E6 and Loom E1, E3, E5, E8 (docs/09 §4) for a non-technical CEO. Capped at 3 when the memo accepts automatic takedowns.",
    "anchors": {
      "1": "Recommendation buried, jargon to the CEO, no ask",
      "3": "Recommendation early but hedged, some numbers, an ask without trade-offs, partly translated",
      "5": "Answer first, MECE and quantified, explicit decisions with trade-offs, pushes back on automatic takedowns, technical detail turned into business impact"
    },
    "subcriteria": [
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E1 (docs/09 §4) in the memo, judged as the label's non-technical CEO would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "memo_e1",
        "title": "E1 Answer first (memo)",
        "anchors": {
          "1": "Recommendation buried or missing",
          "3": "In the first paragraph, but hedged",
          "5": "Recommendation/ask in the first two sentences"
        },
        "sources": [
          "memo"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E2 (docs/09 §4) in the memo, judged as the label's non-technical CEO would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "memo_e2",
        "title": "E2 Pyramid logic (memo)",
        "anchors": {
          "1": "A list of topics or a chronology",
          "3": "Grouped, but overlapping",
          "5": "3–5 MECE supporting points, each a claim that summarises its evidence"
        },
        "sources": [
          "memo"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E3 (docs/09 §4) in the memo, judged as the label's non-technical CEO would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "memo_e3",
        "title": "E3 SCQA framing (memo)",
        "anchors": {
          "1": "No context, or too much",
          "3": "Context given, but the decision question is implicit",
          "5": "Situation + complication in 3 sentences or fewer; decision question explicit"
        },
        "sources": [
          "memo"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E4 (docs/09 §4) in the memo, judged as the label's non-technical CEO would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "memo_e4",
        "title": "E4 Evidence (memo)",
        "anchors": {
          "1": "Assertions only",
          "3": "Some numbers",
          "5": "Key claims quantified and sourced; assumptions stated"
        },
        "sources": [
          "memo"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E5 (docs/09 §4) in the memo, judged as the label's non-technical CEO would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "memo_e5",
        "title": "E5 Decision readiness (memo)",
        "anchors": {
          "1": "No ask",
          "3": "Ask without trade-offs",
          "5": "Options with trade-offs, risks, the specific ask, next steps with owners"
        },
        "sources": [
          "memo"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E6 (docs/09 §4) in the memo, judged as the label's non-technical CEO would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "memo_e6",
        "title": "E6 Economy (memo)",
        "anchors": {
          "1": "Over the limit, or padded",
          "3": "Within the limit, some padding",
          "5": "Within the limit; every paragraph earns its place"
        },
        "sources": [
          "memo"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E1 (docs/09 §4) in the Loom, judged as the label's non-technical CEO would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "loom_e1",
        "title": "E1 Answer first (Loom)",
        "anchors": {
          "1": "Recommendation buried or missing",
          "3": "In the first paragraph, but hedged",
          "5": "Recommendation/ask in the first two sentences"
        },
        "sources": [
          "loom"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E3 (docs/09 §4) in the Loom, judged as the label's non-technical CEO would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "loom_e3",
        "title": "E3 SCQA framing (Loom)",
        "anchors": {
          "1": "No context, or too much",
          "3": "Context given, but the decision question is implicit",
          "5": "Situation + complication in 3 sentences or fewer; decision question explicit"
        },
        "sources": [
          "loom"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E5 (docs/09 §4) in the Loom, judged as the label's non-technical CEO would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "loom_e5",
        "title": "E5 Decision readiness (Loom)",
        "anchors": {
          "1": "No ask",
          "3": "Ask without trade-offs",
          "5": "Options with trade-offs, risks, the specific ask, next steps with owners"
        },
        "sources": [
          "loom"
        ]
      },
      {
        "weight": 1,
        "method": "llm",
        "evidence_required": true,
        "description": "Executive communication behaviour E8 (docs/09 §4) in the Loom, judged as the label's non-technical CEO would read it. Do not score appearance, accent, eye contact, filler words or second-language English (bias risk under EEA s6/s8, no link to job performance).",
        "prompt": "grader-criterion",
        "key": "loom_e8",
        "title": "E8 Audience calibration (Loom)",
        "anchors": {
          "1": "Jargon to an exec",
          "3": "Partly translated",
          "5": "Turns technical detail into business impact without being prompted"
        },
        "sources": [
          "loom"
        ]
      }
    ]
  }
]$criteria_swe_test2$::jsonb,
  $reference_swe_test2${
  "answer_key": {
    "total": 32,
    "items": [
      {
        "id": "A01",
        "conclusion": "Don't build a second YouTube Content ID presence: the aggregator already holds and delivers the assets; Content ID needs exclusive rights, duplicate delivery creates reference overlaps and the first deliverer keeps the claims; repeated erroneous claims risk termination. Use the aggregator's reporting or renegotiate who administers Content ID. Legal's \"start with YouTube\" is the trap.",
        "weight": 3
      },
      {
        "id": "A02",
        "conclusion": "You can't crawl the social platforms (YouTube Data API ~100 searches/day and no downloading/scraping; TikTok Research API academic-only; Instagram hashtag search capped, no audio). Coverage comes from registries and vendors (Audible Magic, Pex/Vobile registry, Meta Rights Manager via DDEX, paid discovery).",
        "weight": 3
      },
      {
        "id": "A03",
        "conclusion": "Build only where vendors don't reach: Stage, SA-hosted websites, and the matching/case layer. Buy or register for everything else.",
        "weight": 3
      },
      {
        "id": "A04",
        "conclusion": "No automatic takedowns: misrepresented takedowns create liability (DMCA §512(f), ECT Act s77(2)), Lenz requires a fair-use consideration, sample-level matching is research-grade. A human confirms every takedown, with a confidence threshold for queueing; push back on the legal head.",
        "weight": 3
      },
      {
        "id": "A05",
        "conclusion": "The fingerprint DB being 40% done is the critical-path dependency: Phase 0 finishes or validates it, or uses vendor-side fingerprinting.",
        "weight": 2
      },
      {
        "id": "A06",
        "conclusion": "Engine choice by use case: Chromaprint for exact duplicates; a Panako-class engine for pitch/tempo tolerance; vendor engines for UGC scale. Stem/sample detection is a research track with a benchmark, not a promise.",
        "weight": 2
      },
      {
        "id": "A07",
        "conclusion": "Security: masters never leave the label's environment; fingerprint locally and send hashes, not audio; keep unreleased material out of third-party registries until release; KMS encryption, least-privilege IAM, access log.",
        "weight": 2
      },
      {
        "id": "A08",
        "conclusion": "Evidence package per case: URL, UTC timestamp, SHA-256 of the capture, match offsets and score, reviewer, chain-of-custody log (ECT s15(3)); notes the tension with YouTube's no-storage rule.",
        "weight": 2
      },
      {
        "id": "A09",
        "conclusion": "Cost drivers are scanning, re-querying and vendor fees, not compute (whole-catalogue fingerprinting is about 185 core-hours); the dedupe ledger (\"Remember\") is the main cost control.",
        "weight": 2
      },
      {
        "id": "A10",
        "conclusion": "Storage sizing roughly right: about 7,400 hours of audio; 24/96 masters about 15 TB in archive tiers (roughly US$15–350/month by tier); hot storage holds fingerprints and proxies only.",
        "weight": 1
      },
      {
        "id": "A11",
        "conclusion": "Honest vendor pricing: most vendors are quote-only; published prices cited with sources (e.g. AudD per-request and per-stream pricing); the R15k/month budget tested explicitly against them: what it buys and what it doesn't.",
        "weight": 2
      },
      {
        "id": "A12",
        "conclusion": "Stage is the quick win: own platform, full data access, ~300 stem downloads a day is tractable; watermark or fingerprint stems at download and monitor reuse.",
        "weight": 2
      },
      {
        "id": "A13",
        "conclusion": "Phasing with exit and kill criteria (e.g. Phase 1 registries + Stage + case management; Phase 2 paid discovery; Phase 3 sample-detection R&D killed if precision at the agreed recall stays below X after N weeks).",
        "weight": 2
      },
      {
        "id": "A14",
        "conclusion": "Maintenance is real: platform API/policy changes, vendor renewals, threshold tuning, false-positive review workload, costed as people-time.",
        "weight": 1
      },
      {
        "id": "A15",
        "conclusion": "Tells the CEO what they can't have: complete TikTok/Instagram coverage through their own system, reliable detection of short altered samples, automatic takedowns.",
        "weight": 2
      }
    ]
  },
  "red_flags": [
    {
      "id": "crawler",
      "description": "Proposes building a social-media crawler or a \"YouTube scraper\".",
      "item_caps": {
        "A02": 0
      }
    },
    {
      "id": "masters_without_security",
      "description": "Proposes uploading masters to a vendor without addressing security.",
      "item_caps": {
        "A07": 0
      }
    },
    {
      "id": "auto_takedowns",
      "description": "Accepts automatic takedowns.",
      "item_caps": {
        "A04": 0
      },
      "criterion_caps": {
        "exec_comms": 3
      }
    },
    {
      "id": "unsourced_vendor_price",
      "description": "Gives a precise vendor price with no source (penalised under A11).",
      "item_caps": {
        "A11": 0.5
      }
    },
    {
      "id": "diagram_no_numbers",
      "description": "A memo that is all diagram and no numbers.",
      "criterion_caps": {
        "cost_model": 2
      }
    }
  ],
  "internal_reference_price": {
    "note": "INTERNAL reference point for admins and calibration only (our own proposal): never sent to a judge, because judge feedback reaches candidates. A credible candidate lands in a similar range with explicit assumptions; a convincing cheaper path (e.g. registries first with a much smaller build) is the thinking we hire for. Score reasoning, not closeness.",
    "build_zar": 525000,
    "build_weeks": 12,
    "run_zar_per_month": [
      20000,
      35000
    ]
  },
  "cost_expectations": [
    "Build effort estimate in rands (people × weeks × rate), with assumptions",
    "Monthly running cost broken into drivers: scanning/discovery, re-querying, vendor fees, storage tiers, people time",
    "USD → ZAR conversion shown with the rate used",
    "Sensitivity: what moves the number (catalogue share scanned, re-query frequency, vendor tier)",
    "Honesty: quote-only vendors stated as assumptions, not invented precision; the R15k/month budget tested explicitly"
  ],
  "security_expectations": [
    "Masters never leave the label's environment; fingerprint locally and send hashes, not audio",
    "Unreleased material kept out of third-party registries until release",
    "KMS encryption, least-privilege IAM, access logging",
    "Evidence package per case with chain of custody (URL, UTC timestamp, SHA-256, match offsets/score, reviewer)",
    "Maintenance: API/policy changes, vendor renewals, threshold tuning, false-positive review, costed as people-time"
  ],
  "phasing_expectations": [
    "Phase 0: finish or validate the 40%-done fingerprint database, or switch to vendor-side fingerprinting",
    "Early phase: free registries + Stage protection + case management (quick win)",
    "Later: paid discovery for the open web; sample-detection R&D as a benchmarked research track",
    "Exit criteria per phase and at least one measurable kill criterion"
  ]
}$reference_swe_test2$::jsonb,
  true)
on conflict (key, version) do update
  set title = excluded.title, criteria = excluded.criteria, reference = excluded.reference;

-- ───────────────────────── Human overrides on submission grades ─────────────────────────
-- final_score is derived, never written directly: admins hold an UPDATE grant on final_score
-- (0008, for interviews), so for submission rows it is recomputed on every update.
create or replace function public.submission_summary_human_override()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.subject_type = 'submission' then
    new.final_score := coalesce(new.human_score, new.median_score);
    if new.human_score is not null then
      new.needs_human_review := false;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists grade_summaries_submission_override on public.grade_summaries;
create trigger grade_summaries_submission_override
  before update on public.grade_summaries
  for each row execute function public.submission_summary_human_override();

create or replace function public.submission_rescore_from_summaries()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent_key text;
  agg record;
  cap numeric;
  mean numeric;
begin
  if position('.' in new.criterion_key) > 0 then
    -- A sub-criterion changed: recompute its parent (same rule as lib/grading aggregateParent).
    -- The parent's own update re-enters this trigger as a top-level row and rescores the submission.
    parent_key := split_part(new.criterion_key, '.', 1);
    select sum(g.final_score * greatest(g.weight, 0)) filter (where g.final_score is not null) as wsum,
           sum(greatest(g.weight, 0)) filter (where g.final_score is not null) as wtot,
           avg(g.final_score) as plain,
           max(g.spread) as spread,
           bool_or(g.final_score is null and g.weight > 0) as incomplete,
           bool_or((g.needs_human_review and g.human_score is null) or g.final_score is null) as review
      into agg
      from public.grade_summaries g
     where g.subject_type = 'submission'
       and g.subject_id = new.subject_id
       and g.criterion_key like parent_key || '.%';
    select (x.extra ->> 'cap')::numeric into cap
      from public.grades x
     where x.subject_type = 'submission'
       and x.subject_id = new.subject_id
       and x.criterion_key = parent_key
       and x.extra ? 'cap'
     order by x.created_at desc
     limit 1;
    mean := case when coalesce(agg.incomplete, false) then null
                 when agg.wtot > 0 then agg.wsum / agg.wtot
                 else agg.plain end;
    if mean is not null and cap is not null then
      mean := least(mean, cap);
    end if;
    update public.grade_summaries p
       set median_score = round(mean, 2),
           spread = agg.spread,
           needs_human_review = p.human_score is null and coalesce(agg.review, false)
     where p.subject_type = 'submission'
       and p.subject_id = new.subject_id
       and p.criterion_key = parent_key;
    return null;
  end if;

  -- A top-level criterion changed: same formula as lib/grading stageScore (weighted mean of
  -- (final - 1) / 4 * 100, to 0.1), and null while any weighted criterion has no final score.
  -- Only once the handler has finished (done / needs_review).
  update public.submissions s
     set score = case
           when exists (
             select 1 from public.grade_summaries g
              where g.subject_type = 'submission' and g.subject_id = s.id
                and position('.' in g.criterion_key) = 0 and g.weight > 0 and g.final_score is null)
           then null
           else (
             select round(
                      case when sum(greatest(g.weight, 0)) > 0
                           then sum((g.final_score - 1) / 4 * 100 * greatest(g.weight, 0)) / sum(greatest(g.weight, 0))
                           else avg((g.final_score - 1) / 4 * 100) end, 1)
               from public.grade_summaries g
              where g.subject_type = 'submission' and g.subject_id = s.id
                and position('.' in g.criterion_key) = 0 and g.final_score is not null)
           end,
         grading_status = case
           when exists (
             select 1 from public.grade_summaries g
              where g.subject_type = 'submission' and g.subject_id = s.id
                and position('.' in g.criterion_key) = 0
                and (g.needs_human_review or (g.weight > 0 and g.final_score is null)))
           then 'needs_review' else 'done' end
   where s.id = new.subject_id
     and s.grading_status in ('done', 'needs_review');
  return null;
end;
$$;
drop trigger if exists grade_summaries_submission_rescore on public.grade_summaries;
create trigger grade_summaries_submission_rescore
  after update of human_score, final_score, median_score, needs_human_review on public.grade_summaries
  for each row
  when (new.subject_type = 'submission')
  execute function public.submission_rescore_from_summaries();

revoke execute on function public.submission_summary_human_override() from public, anon, authenticated;
revoke execute on function public.submission_rescore_from_summaries() from public, anon, authenticated;

notify pgrst, 'reload schema';
