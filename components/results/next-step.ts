// What the candidate can do next for one application. Pure, so it is unit-tested.

export type NextStepInput = {
  role_slug: string;
  stage: string;
  status: string;
  interview: { ended_at: string | null } | null;
  quiz: { submitted_at: string | null } | null;
};

export type NextStep = { href: string; label: string } | null;

const OPEN = ["in_progress", "advanced"];

export function nextStep(app: NextStepInput): NextStep {
  if (!OPEN.includes(app.status)) return null;
  if (app.stage === "interview") {
    if (app.interview?.ended_at) return null; // finished; the quiz unlocks automatically
    return {
      href: `/apply/${app.role_slug}/interview`,
      label: app.interview ? "Continue the AI CV interview" : "Start the AI CV interview",
    };
  }
  if (app.stage === "quiz") {
    if (app.quiz?.submitted_at) return null;
    return {
      href: `/apply/${app.role_slug}/quiz`,
      label: app.quiz ? "Continue the role quiz" : "Start the role quiz",
    };
  }
  return null;
}
