import { SOLUTION_BRIEF_MD } from "../../synth/bundle-b";
import { execCommsSubs } from "./shared";
import type { RubricDefinition } from "./types";

/** BA Part 2: build and handoff (docs/06). docs/06 gives weights only; the anchors here follow docs/09's style. */

const REQUIRED_FEATURES = [
  "Renewal queue: lines and customers entering the 90-day window, prioritised, with eligibility rules applied (three months before end date; one month for last-month-only plans)",
  "Customer 360: accounts, lines, contact points with consent status, interaction history",
  "Log outcome: a callback date is REQUIRED for \"Call back\"; quote, sale and not-interested outcomes available",
  "Message: compose from an approved template, blocked if there is no consent or the customer has opted out; queued, not actually sent",
  "Manager exceptions view: missing next actions, overdue callbacks, customers with no valid contact point",
];

export const BA_PART2: RubricDefinition = {
  key: "ba_part2",
  version: 1,
  title: "BA Part 2: build and handoff",
  criteria: [
    {
      key: "data_model",
      title: "Data model correctness",
      weight: 25,
      method: "llm",
      prompt: "grader-criterion",
      evidence_required: true,
      sources: ["handoff"],
      reference_keys: ["data_model_expectations"],
      description:
        "ERD, table definitions and one-sentence grain per table: grain, keys, consent modelled per contact point, history as events, no line/customer confusion.",
      anchors: {
        "1": "No ERD or table definitions, or the model confuses line and customer grain; consent stored per customer or not at all; interactions overwrite state",
        "3": "ERD and definitions with mostly correct grain and keys, but gaps: consent not per contact point, history kept as a status field, or customer → account → line relations partly wrong",
        "5": "Grain stated for every table; customer → account → line with correct keys and the MSISDN never used as the customer; consent and verification per contact point; interactions and next actions as append-only events; eligibility derived from the end date, not the stale export status",
      },
    },
    {
      key: "mvp",
      title: "MVP functionality",
      weight: 25,
      method: "llm",
      prompt: "grader-criterion",
      evidence_required: true,
      sources: ["mvp", "loom"],
      reference_keys: ["required_features"],
      human_check: "Rubric requires a human click-through of the hosted MVP (docs/06: automated click-through plus human check)",
      description: "The hosted MVP running on the provided data, judged from the snapshot of the MVP URL and the Loom demo, against the five required features.",
      anchors: {
        "1": "No working hosted MVP, or it does not run on the provided data; most required features missing",
        "3": "Hosted and running on the data; 3–4 of the 5 required features work, but rules are UI-only or partial (callback date optional, messaging not blocked for opted-out customers)",
        "5": "All five features work on the provided data: prioritised 90-day queue with eligibility rules, customer 360 with consent, outcome logging that cannot save \"Call back\" without a date, template messaging blocked without consent or after opt-out (queued, not sent), and the manager exceptions view",
      },
    },
    {
      key: "handoff",
      title: "Handoff quality",
      weight: 30,
      method: "llm",
      prompt: "grader-criterion",
      evidence_required: true,
      sources: ["handoff"],
      reference_keys: ["handoff_sections", "business_rules", "required_features"],
      description: "Testable acceptance criteria, rules, access matrix, edge cases. The test: could the engineer build it without asking?",
      anchors: {
        "1": "The engineer would have to ask about most things: stories without acceptance criteria, rules missing, no access matrix",
        "3": "Stories with some Given/When/Then ACs and the main rules, but untestable or missing ACs for key flows, a partial access matrix, few edge cases or non-functional needs",
        "5": "Buildable without asking: testable Given/When/Then ACs for every story; eligibility, consent, allocation and dedupe rules stated precisely; a complete role × action matrix (agent, manager, admin); edge cases, non-functional needs, out of scope and open questions",
      },
    },
    {
      key: "exec_comms_loom",
      title: "Executive communication (Loom to Lerato)",
      weight: 10,
      method: "llm",
      evidence_required: true,
      description: "Mean of E1, E3, E5 and E8 (docs/09 §4) on the Loom transcript, addressed to Lerato.",
      anchors: {
        "1": "No clear point or ask; technical walkthrough aimed at engineers",
        "3": "Recommendation stated but hedged; an ask without trade-offs; partly translated for an executive",
        "5": "Answer first, situation and decision framed in a few sentences, a specific ask with trade-offs, technical detail turned into business impact",
      },
      subcriteria: execCommsSubs(["E1", "E3", "E5", "E8"], { artefact: "Loom", sources: ["loom"], audience: "Lerato, the client GM" }),
    },
    {
      key: "judgement",
      title: "Judgement: what was left out and why",
      weight: 10,
      method: "llm",
      prompt: "grader-criterion",
      evidence_required: true,
      sources: ["handoff", "loom"],
      reference_keys: ["solution_brief"],
      description: "The handoff's out-of-scope list and the Loom: what the candidate deliberately did not build, and whether the reasons follow from the brief and the data.",
      anchors: {
        "1": "No out-of-scope list, or builds what the Solution Brief excludes (bulk outreach, dashboards, dialler integration) without saying why",
        "3": "Lists what was left out, with thin reasons not tied to the brief or the data",
        "5": "Explicit, reasoned cuts tied to the Solution Brief and the data (e.g. no bulk outreach until contactable share passes 60%, no real sending, no dialler integration without an API), and says what would change the decision",
      },
    },
  ],
  reference: {
    solution_brief: SOLUTION_BRIEF_MD,
    required_features: REQUIRED_FEATURES,
    data_model_expectations: [
      "customers (one row per company; reg_no; normalised_name) → accounts (dealer account numbers; many per customer) → lines (one per MSISDN in E.164; end date, plan, monthly charge in rands)",
      "Line status derived from contract_end_date, not the export's stale status; eligible_from = end date − 3 months, or − 1 month for last-month-only plans",
      "contact_points per customer with type, value, role (decision maker / admin), verified_at, consent_status (opted_in / existing_customer_s69_3 / opted_out / unknown) and source",
      "interactions as append-only events with outcome and next_action_at; a callback without a date is impossible",
      "Opt-outs matched to customers (the legal list is by company name) and enforced before any message is queued",
      "Agents, managers and admins as users with roles; allocation of customers or lines to agents",
    ],
    handoff_sections: [
      "The problem and the POV in 5 lines",
      "User stories with Given/When/Then acceptance criteria",
      "Business rules: eligibility, consent, allocation, deduplication",
      "Access matrix: role × action (agent, manager, admin)",
      "Edge cases",
      "Non-functional needs",
      "Out of scope",
      "Open questions",
    ],
    business_rules: [
      "Eligibility: from three months before contract end; some price plans only in the last month",
      "Consent: message only verified contact points with opted_in or existing_customer_s69_3 status, never opted_out; opt-out offered in every message",
      "A \"Call back\" outcome requires a dated next action; every interaction ends in a dated next step",
      "Deduplication: one customer across several accounts and name variants (reg no where present, normalised name otherwise)",
      "Bulk outreach out of scope until the contactable share passes 60%",
    ],
  },
};
