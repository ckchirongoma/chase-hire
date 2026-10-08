// Offline stand-in for interview-grader.v1 (one criterion per call) plus the JEV answers the
// interview uses (claim selection and per-turn flow control).
//
// Evidence quotes are copied from the candidate's messages in the <transcript> it receives,
// so the platform's quote verification passes. Markers in candidate text drive edge cases
// for tests: STUB:NO_EVIDENCE (never quotes), STUB:NO_EVIDENCE_ONCE (quotes only on the
// re-run), STUB:FAKE_QUOTE (quotes text that isn't there), STUB:SPREAD (scores 1/3/5 across
// samples).

const SCORES = { specificity: 4, ownership: 3, depth_under_probe: 3, cv_consistency: 4, situational_judgement: 3, communication: 4 };
const spreadCounters = new Map();

function candidateBlocks(text) {
  const t = text.match(/<transcript>\n([\s\S]*)\n<\/transcript>/)?.[1] ?? text.match(/<submission>\n([\s\S]*)\n<\/submission>/)?.[1] ?? "";
  const blocks = [];
  const re = /^\[#(\d+) ([^\]\n]+)\]\n([\s\S]*?)(?=\n\n\[#\d+ |$(?![\s\S]))/gm;
  for (const m of t.matchAll(re)) if (m[2].startsWith("candidate")) blocks.push({ idx: Number(m[1]), text: m[3].trim() });
  if (!blocks.length && t.trim()) blocks.push({ idx: 0, text: t.trim() });
  return blocks;
}

export default function interviewGrader(_body, { text }) {
  const key = text.match(/CRITERION: .*\(key: ([\w-]+)\)/)?.[1] ?? "unknown";
  const blocks = candidateBlocks(text);
  const all = blocks.map((b) => b.text).join("\n");
  const nudged = text.includes("Your previous answer for this criterion had no evidence");

  let evidence = blocks
    .filter((b) => b.text.split(/\s+/).length >= 3)
    .slice(0, 2)
    .map((b) => ({ quote: b.text.split(/\s+/).slice(0, 10).join(" "), location: `#${b.idx}` }));
  if (all.includes("STUB:NO_EVIDENCE_ONCE") ? !nudged : all.includes("STUB:NO_EVIDENCE")) evidence = [];
  if (all.includes("STUB:FAKE_QUOTE")) evidence = [{ quote: "a sentence the candidate never wrote", location: "#1" }];

  let score = SCORES[key] ?? 3;
  if (all.includes("STUB:SPREAD")) {
    const n = spreadCounters.get(key) ?? 0;
    spreadCounters.set(key, n + 1);
    score = [1, 3, 5][n % 3];
  }
  return {
    evidence,
    rationale: `Stub rationale for ${key}: compared the quoted answers with the anchors.`,
    score,
    feedback: `Stub feedback for ${key}.`,
  };
}

const words = (s) => String(s ?? "").trim().split(/\s+/).filter(Boolean).length;

/** JEV answers for the interview; returns null for anyone else's requests. */
export function jev(body) {
  const state = body?.state ?? {};
  const qs = body?.questions ?? {};
  const answers = {};

  if (typeof state.task === "string" && state.task.startsWith("Choose which parts of a CV")) {
    for (const [id, q] of Object.entries(qs)) {
      const keys = Object.keys(q.criteria ?? {});
      let choice = keys[0];
      if (id === "impressive_claim") {
        const biggest = (s) => Math.max(0, ...(String(s).replace(/,/g, "").match(/\d+/g) ?? []).map(Number));
        choice = keys.reduce((a, b) => (biggest(q.criteria[b]) > biggest(q.criteria[a]) ? b : a), keys[0]);
      } else if (id === "closest_claim") {
        choice = keys.find((k) => /workshop|discovery|stakeholder|requirement/i.test(q.criteria[k])) ?? keys[0];
      } else if (id.startsWith("req_")) {
        // Role requirement → the first claim with matching words, else "none".
        const re = { data: /dataset|spreadsheet|excel/i, discovery: /workshop|discovery|stakeholder/i, prototype: /built|automat|prototype/i }[id.slice(4)];
        choice = (re && keys.find((k) => k !== "none" && re.test(q.criteria[k]))) || "none";
      }
      answers[id] = { type: "choice", choice, confidence: 0.8, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 0.8 : 0.2 / Math.max(1, keys.length - 1)])) };
    }
    return { model: "jev-stub", answers, usage: { input_tokens: 1, output_tokens: 1 } };
  }

  if (typeof state.context === "string" && state.context.startsWith("Structured job-screening conversation")) {
    const msg = String(state.candidate_answer ?? "");
    for (const [id, q] of Object.entries(qs)) {
      if (id === "off_script") answers[id] = { type: "noul", noul: /ignore (all|previous|your)|grade me|scor(e|ed|ing)|your instructions|full marks/i.test(msg) ? 0.95 : 0.05 };
      else if (id === "role_question")
        answers[id] = { type: "noul", noul: /\?\s*$/.test(msg) && /\b(role|company|team|salary|pay|clients?|office|benefits|leave)\b/i.test(msg) ? 0.9 : 0.05 };
      // Thin (under 25 words) or marked "[needs-followup]" → not sufficient, so a follow-up is asked.
      else if (id === "sufficient") answers[id] = { type: "noul", noul: words(msg) < 25 || msg.includes("[needs-followup]") ? 0.1 : 0.9 };
      else if (id === "missing") {
        const keys = Object.keys(q.criteria ?? {});
        const choice = keys[keys.length - 1]; // the last option, so tests can tell JEV from the doc-order fallback
        answers[id] = { type: "choice", choice, confidence: 0.7, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 0.7 : 0.3 / Math.max(1, keys.length - 1)])) };
      }
    }
    return { model: "jev-stub", answers, usage: { input_tokens: 1, output_tokens: 1 } };
  }
  return null;
}
