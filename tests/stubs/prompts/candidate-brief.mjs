// Offline stand-in for candidate-brief.v1: a fixed brief that echoes what it was given, so tests
// can check the inputs (roles, stars) and that no name or contact details were sent.
export default function candidateBrief(_body, { text }) {
  const roles = [...new Set([...text.matchAll(/"role":"([^"]+)"/g)].map((m) => m[1]))];
  const stars = text.match(/"stars":(\d)/)?.[1] ?? "none";
  const contact = /@|"full_name"|"phone"|"email"/.test(text) ? "present" : "none";
  return {
    headline: "Stub analyst with reporting experience",
    summary: `Stub brief. Reasoning stars: ${stars}. Roles: ${roles.join(", ") || "none"}. Contact details: ${contact}.`,
    strengths: [{ point: "Automated reporting work on the CV", evidence: "CV" }],
    concerns: [{ point: "No work assessment yet", evidence: "applications" }],
    recommendations: roles.map((role) => ({
      role,
      recommendation: "too_early",
      confidence: "low",
      reasoning: "Stub: only the early stages are done.",
      check_next: "The interview transcript",
    })),
    live_questions: ["Walk us through the reporting pipeline."],
  };
}
