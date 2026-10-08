// Offline stand-in for elicitation-grader.v1 (BA Part 1 question quality).
// Quotes the candidate's messages from the stakeholder transcript with their "#<index>".
// STUB:SCORE:elicitation.quality=<n> in a candidate message sets the score (default 4).
import { criterionKey, scoreFor, submissionBody } from "./grader-criterion.mjs";

export default function elicitationGrader(_body, { text }) {
  const body = submissionBody(text);
  const key = criterionKey(text);
  const evidence = [];
  const re = /^\[#(\d+) candidate · ref:\w+\]\n([\s\S]*?)(?=\n\n\[#\d+ |$(?![\s\S]))/gm;
  for (const m of body.matchAll(re)) {
    const words = m[2].trim().split(/\s+/);
    if (words.length >= 3 && evidence.length < 2) evidence.push({ quote: words.slice(0, 10).join(" "), location: `#${m[1]}` });
  }
  return {
    evidence,
    rationale: `Stub rationale for ${key}: judged the questioning, not the yield.`,
    score: scoreFor(key, body, 4),
    feedback: "Stub feedback for questioning.",
  };
}
