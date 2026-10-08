// Offline stand-in for grader-criterion.v1 (one work-sample criterion per call).
//
// Evidence quotes are copied from the content inside <submission>, so the platform's quote
// verification passes. Markers in the submission drive tests:
//   STUB:SCORE:<key>=<n>   score n for that criterion key (e.g. STUB:SCORE:spiky_pov.p1=5)
//   STUB:SPREAD:<key>      scores 1 / 3 / 5 across the three samples of that key
//   STUB:NO_EVIDENCE:<key> never quotes for that key (sample becomes invalid)
//   STUB:LEAK_FEEDBACK     feedback quotes internal material (answer-key ids, an internal price)
// Answer-key judges (gap-recall-grader, answer-key-grader) also understand, via mappingFor():
//   STUB:OMIT_MAPPING      never returns reference_mapping (both tries fail validation)
//   STUB:OMIT_MAPPING_ONCE the first try maps only part of the key; the retry maps all of it
//   STUB:FABRICATE         marks every id found, quoting text that is not in the submission
// Other modules import the helpers below.

const DEFAULT_SCORES = { "spiky_pov.p3": 2 };
const counters = new Map();

/** The text inside the <submission> tags (labels like [MEMO] included). */
export function submissionBody(text) {
  return text.match(/<submission>\n([\s\S]*)\n<\/submission>/)?.[1] ?? "";
}

/** Content lines a quote may come from: no [LABEL] lines, no transcript headers, no markers. */
export function contentLines(body) {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^\[[A-Z0-9 .()_/-]+\]$/.test(l) && !/^\[#\d+ /.test(l) && !l.includes("STUB:"));
}

export function quotes(body, n = 2) {
  return contentLines(body)
    .filter((l) => l.split(/\s+/).length >= 3)
    .slice(0, n)
    .map((l, i) => ({ quote: l.split(/\s+/).slice(0, 10).join(" "), location: `line ${i + 1}` }));
}

export function criterionKey(text) {
  return text.match(/CRITERION: .*\(key: ([\w.-]+)\)/)?.[1] ?? "unknown";
}

/** Ids listed in a REFERENCE block as "<ID> [tags]: ...". */
export function referenceIds(text, prefix) {
  const ref = text.split("SUBMISSION:")[0];
  return [...new Set([...ref.matchAll(new RegExp(`^(${prefix}\\d{2}) \\[`, "gm"))].map((m) => m[1]))];
}

/** Ids listed after a marker, e.g. "STUB:FOUND=D01,D02" (all occurrences). */
export function markerList(body, name) {
  const out = [];
  for (const m of body.matchAll(new RegExp(`STUB:${name}=([\\w,.-]+)`, "g"))) out.push(...m[1].split(",").filter(Boolean));
  return out;
}

/** The leaky feedback a careless judge might write (the platform must withhold it). */
export const LEAKY_FEEDBACK = "You missed A01 and A04; our internal proposal was R525,000 over 12 weeks and R20-35k a month.";

/** True on chatJson's validation retry (the conversation then carries the first answer and the error). */
export function isRetry(body) {
  return Array.isArray(body?.messages) && body.messages.length > 2;
}

/**
 * Applies the mapping markers to a full mapping: returns undefined (omit the field), a partial
 * mapping on the first try, or fabricated "found" items; otherwise the mapping unchanged.
 */
export function mappingFor(body, sub, mapping) {
  if (sub.includes("STUB:OMIT_MAPPING_ONCE")) return isRetry(body) ? mapping : mapping.slice(0, 3);
  if (sub.includes("STUB:OMIT_MAPPING")) return undefined;
  if (sub.includes("STUB:FABRICATE")) return mapping.map((m) => ({ id: m.id, status: "found", quote: `Invented quote proving ${m.id} that the memo never says` }));
  return mapping;
}

export function nextCount(key) {
  const n = counters.get(key) ?? 0;
  counters.set(key, n + 1);
  return n;
}

export function scoreFor(key, body, fallback = 3) {
  const m = body.match(new RegExp(`STUB:SCORE:${key.replace(/\./g, "\\.")}=(\\d)`));
  if (m) return Number(m[1]);
  if (body.includes(`STUB:SPREAD:${key}`)) return [1, 3, 5][nextCount(`spread|${key}|${body.length}`) % 3];
  return DEFAULT_SCORES[key] ?? fallback;
}

export default function graderCriterion(_body, { text }) {
  const key = criterionKey(text);
  const body = submissionBody(text);
  const evidence = body.includes(`STUB:NO_EVIDENCE:${key}`) ? [] : quotes(body);
  return {
    evidence,
    reference_mapping: [],
    rationale: `Stub rationale for ${key}: compared the quoted work with the anchors.`,
    score: scoreFor(key, body),
    feedback: body.includes("STUB:LEAK_FEEDBACK") ? LEAKY_FEEDBACK : `Stub feedback for ${key}.`,
  };
}
