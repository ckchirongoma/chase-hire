// Offline stand-in for interview-concerns.v1: one concern about the first CV claim the
// interviewer asked about, and three panel follow-ups.
// STUB:CONCERNS_FAIL in the transcript returns output that fails the schema (one follow-up),
// so tests can check that a failed concerns call doesn't lose the criterion grades or score.
export default function interviewConcerns(_body, { text }) {
  if (text.includes("STUB:CONCERNS_FAIL")) return { verification_concerns: [], live_followups: ["Only one follow-up."] };
  const claim = text.match(/Your CV says you '([^']+)'/)?.[1] ?? null;
  return {
    verification_concerns: claim ? [{ claim, reason: "Stub: the answer did not say how the result was measured (#3)." }] : [],
    live_followups: [
      claim ? `Walk us through how you measured the result when you ${claim}.` : "Walk us through a recent result you measured.",
      "Which decision in that work would you reverse now, and why?",
      "Show us one artefact (query, spreadsheet or code) from that project and explain it.",
    ],
  };
}
