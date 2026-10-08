// Offline stand-in for answer-key-grader.v1 (SWE Test 1 F-codes, SWE Test 2 A-codes).
// Every A/F id listed in the REFERENCE comes back mapped. Markers in the submission:
//   STUB:FOUND=A01,A02     found in every sample
//   STUB:PARTIAL=A05       partial in every sample
//   STUB:RED_FLAGS=auto_takedowns,crawler   reported by every sample
//   STUB:RED_FLAG_ONCE=crawler              reported by one sample only (not a majority)
//   STUB:RED_FLAG_UNQUOTED=crawler          reported by every sample with a quote not in the submission
//   plus STUB:OMIT_MAPPING / STUB:OMIT_MAPPING_ONCE / STUB:FABRICATE / STUB:LEAK_FEEDBACK (see grader-criterion.mjs)
import { contentLines, criterionKey, LEAKY_FEEDBACK, mappingFor, markerList, nextCount, quotes, referenceIds, submissionBody } from "./grader-criterion.mjs";

export default function answerKeyGrader(req, { text }) {
  const body = submissionBody(text);
  const ids = [...referenceIds(text, "A"), ...referenceIds(text, "F")];
  const found = new Set(markerList(body, "FOUND"));
  const partial = new Set(markerList(body, "PARTIAL"));
  const line = contentLines(body).find((l) => l.split(/\s+/).length >= 3) ?? "";
  const snippet = line.split(/\s+/).slice(0, 8).join(" ");
  const sample = nextCount(`ak|${criterionKey(text)}|${body.length}`) % 3;
  const flags = [...markerList(body, "RED_FLAGS"), ...(sample === 0 ? markerList(body, "RED_FLAG_ONCE") : [])];
  const full = ids.map((id) => {
    const status = found.has(id) ? "found" : partial.has(id) ? "partial" : "missing";
    return { id, status, quote: status === "missing" ? "" : snippet };
  });
  const reference_mapping = mappingFor(req, body, full);
  return {
    evidence: quotes(body),
    ...(reference_mapping ? { reference_mapping } : {}),
    red_flags_triggered: [
      ...flags.map((id) => ({ id, quote: snippet })),
      ...markerList(body, "RED_FLAG_UNQUOTED").map((id) => ({ id, quote: "We will build a crawler for every platform" })),
    ],
    rationale: `Stub rationale for ${criterionKey(text)}: mapped the work to the answer key.`,
    score: 3,
    feedback: body.includes("STUB:LEAK_FEEDBACK") ? LEAKY_FEEDBACK : "Stub feedback for the answer key.",
  };
}
