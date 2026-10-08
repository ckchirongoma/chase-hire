// Offline stand-in for gap-recall-grader.v1 (BA Part 1 gap recall).
// Every D-code listed in the REFERENCE comes back mapped. Markers in the submission:
//   STUB:FOUND=D01,D02     found in every sample
//   STUB:PARTIAL=D03       partial in every sample
//   STUB:FLIP=D04          found, missing, found across successive samples (median found)
//   STUB:EXTRA_GAP         reports one gap outside the key
//   plus STUB:OMIT_MAPPING / STUB:OMIT_MAPPING_ONCE / STUB:FABRICATE / STUB:LEAK_FEEDBACK (see grader-criterion.mjs)
import { contentLines, criterionKey, LEAKY_FEEDBACK, mappingFor, markerList, nextCount, quotes, referenceIds, submissionBody } from "./grader-criterion.mjs";

export default function gapRecallGrader(req, { text }) {
  const body = submissionBody(text);
  const ids = referenceIds(text, "D");
  const found = new Set(markerList(body, "FOUND"));
  const partial = new Set(markerList(body, "PARTIAL"));
  const flip = new Set(markerList(body, "FLIP"));
  const sample = nextCount(`gap|${body.length}`) % 3;
  const line = contentLines(body).find((l) => l.split(/\s+/).length >= 3) ?? "";
  const full = ids.map((id) => {
    let status = found.has(id) ? "found" : partial.has(id) ? "partial" : "missing";
    if (flip.has(id)) status = sample === 1 ? "missing" : "found";
    return { id, status, quote: status === "missing" ? "" : line.split(/\s+/).slice(0, 8).join(" ") };
  });
  const reference_mapping = mappingFor(req, body, full);
  return {
    evidence: quotes(body),
    ...(reference_mapping ? { reference_mapping } : {}),
    extra_valid_gaps: body.includes("STUB:EXTRA_GAP") ? [{ gap: "Duplicate MSISDNs across two accounts", quote: line.split(/\s+/).slice(0, 6).join(" ") }] : [],
    rationale: `Stub rationale for ${criterionKey(text)}: mapped the gap log to the key.`,
    score: 3,
    feedback: body.includes("STUB:LEAK_FEEDBACK") ? LEAKY_FEEDBACK : "Stub feedback for gap recall.",
  };
}
