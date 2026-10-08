import type { RedFlagRule } from "../reference";
import { execCommsSubs } from "./shared";
import type { RubricDefinition } from "./types";

/** SWE Test 2: architecture and costing, catalogue protection (docs/08). Answer key is INTERNAL. */

export const ARCH_KEY = [
  { id: "A01", conclusion: "Don't build a second YouTube Content ID presence: the aggregator already holds and delivers the assets; Content ID needs exclusive rights, duplicate delivery creates reference overlaps and the first deliverer keeps the claims; repeated erroneous claims risk termination. Use the aggregator's reporting or renegotiate who administers Content ID. Legal's \"start with YouTube\" is the trap.", weight: 3 },
  { id: "A02", conclusion: "You can't crawl the social platforms (YouTube Data API ~100 searches/day and no downloading/scraping; TikTok Research API academic-only; Instagram hashtag search capped, no audio). Coverage comes from registries and vendors (Audible Magic, Pex/Vobile registry, Meta Rights Manager via DDEX, paid discovery).", weight: 3 },
  { id: "A03", conclusion: "Build only where vendors don't reach: Stage, SA-hosted websites, and the matching/case layer. Buy or register for everything else.", weight: 3 },
  { id: "A04", conclusion: "No automatic takedowns: misrepresented takedowns create liability (DMCA §512(f), ECT Act s77(2)), Lenz requires a fair-use consideration, sample-level matching is research-grade. A human confirms every takedown, with a confidence threshold for queueing; push back on the legal head.", weight: 3 },
  { id: "A05", conclusion: "The fingerprint DB being 40% done is the critical-path dependency: Phase 0 finishes or validates it, or uses vendor-side fingerprinting.", weight: 2 },
  { id: "A06", conclusion: "Engine choice by use case: Chromaprint for exact duplicates; a Panako-class engine for pitch/tempo tolerance; vendor engines for UGC scale. Stem/sample detection is a research track with a benchmark, not a promise.", weight: 2 },
  { id: "A07", conclusion: "Security: masters never leave the label's environment; fingerprint locally and send hashes, not audio; keep unreleased material out of third-party registries until release; KMS encryption, least-privilege IAM, access log.", weight: 2 },
  { id: "A08", conclusion: "Evidence package per case: URL, UTC timestamp, SHA-256 of the capture, match offsets and score, reviewer, chain-of-custody log (ECT s15(3)); notes the tension with YouTube's no-storage rule.", weight: 2 },
  { id: "A09", conclusion: "Cost drivers are scanning, re-querying and vendor fees, not compute (whole-catalogue fingerprinting is about 185 core-hours); the dedupe ledger (\"Remember\") is the main cost control.", weight: 2 },
  { id: "A10", conclusion: "Storage sizing roughly right: about 7,400 hours of audio; 24/96 masters about 15 TB in archive tiers (roughly US$15–350/month by tier); hot storage holds fingerprints and proxies only.", weight: 1 },
  { id: "A11", conclusion: "Honest vendor pricing: most vendors are quote-only; published prices cited with sources (e.g. AudD per-request and per-stream pricing); the R15k/month budget tested explicitly against them: what it buys and what it doesn't.", weight: 2 },
  { id: "A12", conclusion: "Stage is the quick win: own platform, full data access, ~300 stem downloads a day is tractable; watermark or fingerprint stems at download and monitor reuse.", weight: 2 },
  { id: "A13", conclusion: "Phasing with exit and kill criteria (e.g. Phase 1 registries + Stage + case management; Phase 2 paid discovery; Phase 3 sample-detection R&D killed if precision at the agreed recall stays below X after N weeks).", weight: 2 },
  { id: "A14", conclusion: "Maintenance is real: platform API/policy changes, vendor renewals, threshold tuning, false-positive review workload, costed as people-time.", weight: 1 },
  { id: "A15", conclusion: "Tells the CEO what they can't have: complete TikTok/Instagram coverage through their own system, reliable detection of short altered samples, automatic takedowns.", weight: 2 },
] as const;

export const RED_FLAGS: RedFlagRule[] = [
  { id: "crawler", description: "Proposes building a social-media crawler or a \"YouTube scraper\".", item_caps: { A02: 0 } },
  { id: "masters_without_security", description: "Proposes uploading masters to a vendor without addressing security.", item_caps: { A07: 0 } },
  { id: "auto_takedowns", description: "Accepts automatic takedowns.", item_caps: { A04: 0 }, criterion_caps: { exec_comms: 3 } },
  { id: "unsourced_vendor_price", description: "Gives a precise vendor price with no source (penalised under A11).", item_caps: { A11: 0.5 } },
  { id: "diagram_no_numbers", description: "A memo that is all diagram and no numbers.", criterion_caps: { cost_model: 2 } },
];

export const SWE_TEST2: RubricDefinition = {
  key: "swe_test2",
  version: 1,
  title: "SWE Test 2: architecture, costing and security",
  criteria: [
    {
      key: "answer_key",
      title: "Answer-key coverage",
      weight: 35,
      method: "computed",
      computation: "answer_key",
      prompt: "answer-key-grader",
      evidence_required: true,
      sources: ["memo", "loom"],
      reference_keys: ["answer_key", "red_flags"],
      baseline: "optional",
      description:
        "Weighted coverage of A01–A15 (max 32) from the memo and Loom, with red-flag caps: a crawler zeroes A02, uploading masters without security zeroes A07, accepting automatic takedowns zeroes A04 and caps executive communication at 3, an unsourced precise vendor price halves A11. Score = 1 + 4 × coverage; a red flag counts when 2 of 3 samples report it.",
      anchors: {
        "1": "Covers almost none of A01–A15, or red flags zero the critical items",
        "3": "About half of the weighted key (about 16 of 32), including at least two of the critical judgements A01–A04",
        "5": "Nearly the full key (29+ of 32) with no red flags: no second Content ID presence, registries and vendors instead of crawling, build only where vendors don't reach, human-confirmed takedowns",
      },
    },
    {
      key: "cost_model",
      title: "Cost model quality",
      weight: 20,
      method: "llm",
      prompt: "grader-criterion",
      evidence_required: true,
      sources: ["memo"],
      reference_keys: ["cost_expectations"],
      description: "Drivers, assumptions, sensitivity, rand conversion, and honesty about unknown vendor prices.",
      anchors: {
        "1": "No cost model, or a single number without drivers or assumptions; invented vendor precision; no rand conversion",
        "3": "Build and run costs with some drivers and assumptions and a partial USD → ZAR conversion; little sensitivity analysis; the R15k/month budget tested only loosely",
        "5": "Build effort and monthly run cost in rands broken into drivers (scanning, re-querying, vendor fees, people), assumptions stated, USD → ZAR shown with the rate, sensitivity on what moves the number, honest about quote-only vendors, and the R15k/month budget tested explicitly",
      },
    },
    {
      key: "security_maintenance",
      title: "Security and maintenance depth",
      weight: 10,
      method: "llm",
      prompt: "grader-criterion",
      evidence_required: true,
      sources: ["memo"],
      reference_keys: ["security_expectations"],
      description: "Protection of unreleased masters and the evidence trail; what breaks over time, who watches it, and its cost.",
      anchors: {
        "1": "No security plan for unreleased masters or the evidence trail; maintenance not mentioned",
        "3": "Some controls (encryption, access control) and a maintenance list, but masters may leave the environment, or maintenance is costed as infrastructure only",
        "5": "Masters never leave the label's environment (local fingerprinting, hashes not audio), KMS + least privilege + access logs, a chain-of-custody evidence package; maintenance costed as people-time (API/policy changes, vendor renewals, threshold tuning, false-positive review)",
      },
    },
    {
      key: "phasing_kill",
      title: "Phasing and kill criteria",
      weight: 10,
      method: "llm",
      prompt: "grader-criterion",
      evidence_required: true,
      sources: ["memo"],
      reference_keys: ["phasing_expectations"],
      description: "Phases with exit criteria and at least one kill criterion that would stop or redirect the project.",
      anchors: {
        "1": "No phases, or phases with no exit criteria and no kill criterion",
        "3": "Phases with some exit criteria but no measurable kill criterion, or the fingerprint-DB dependency ignored",
        "5": "Phases with measurable exit criteria, Phase 0 on the 40%-done fingerprint database, a quick win on Stage, and at least one measurable kill criterion (e.g. stop sample detection if precision at the agreed recall stays below X after N weeks)",
      },
    },
    {
      key: "exec_comms",
      title: "Executive communication (memo + Loom to the CEO)",
      weight: 25,
      method: "llm",
      evidence_required: true,
      description: "Mean of memo E1–E6 and Loom E1, E3, E5, E8 (docs/09 §4) for a non-technical CEO. Capped at 3 when the memo accepts automatic takedowns.",
      anchors: {
        "1": "Recommendation buried, jargon to the CEO, no ask",
        "3": "Recommendation early but hedged, some numbers, an ask without trade-offs, partly translated",
        "5": "Answer first, MECE and quantified, explicit decisions with trade-offs, pushes back on automatic takedowns, technical detail turned into business impact",
      },
      subcriteria: [
        ...execCommsSubs(["E1", "E2", "E3", "E4", "E5", "E6"], { artefact: "memo", sources: ["memo"], keyPrefix: "memo_", audience: "the label's non-technical CEO" }),
        ...execCommsSubs(["E1", "E3", "E5", "E8"], { artefact: "Loom", sources: ["loom"], keyPrefix: "loom_", audience: "the label's non-technical CEO" }),
      ],
    },
  ],
  reference: {
    answer_key: { total: 32, items: ARCH_KEY },
    red_flags: RED_FLAGS,
    internal_reference_price: {
      note: "INTERNAL reference point for admins and calibration only (our own proposal): never sent to a judge, because judge feedback reaches candidates. A credible candidate lands in a similar range with explicit assumptions; a convincing cheaper path (e.g. registries first with a much smaller build) is the thinking we hire for. Score reasoning, not closeness.",
      build_zar: 525000,
      build_weeks: 12,
      run_zar_per_month: [20000, 35000],
    },
    cost_expectations: [
      "Build effort estimate in rands (people × weeks × rate), with assumptions",
      "Monthly running cost broken into drivers: scanning/discovery, re-querying, vendor fees, storage tiers, people time",
      "USD → ZAR conversion shown with the rate used",
      "Sensitivity: what moves the number (catalogue share scanned, re-query frequency, vendor tier)",
      "Honesty: quote-only vendors stated as assumptions, not invented precision; the R15k/month budget tested explicitly",
    ],
    security_expectations: [
      "Masters never leave the label's environment; fingerprint locally and send hashes, not audio",
      "Unreleased material kept out of third-party registries until release",
      "KMS encryption, least-privilege IAM, access logging",
      "Evidence package per case with chain of custody (URL, UTC timestamp, SHA-256, match offsets/score, reviewer)",
      "Maintenance: API/policy changes, vendor renewals, threshold tuning, false-positive review, costed as people-time",
    ],
    phasing_expectations: [
      "Phase 0: finish or validate the 40%-done fingerprint database, or switch to vendor-side fingerprinting",
      "Early phase: free registries + Stage protection + case management (quick win)",
      "Later: paid discovery for the open web; sample-detection R&D as a benchmarked research track",
      "Exit criteria per phase and at least one measurable kill criterion",
    ],
  },
};
