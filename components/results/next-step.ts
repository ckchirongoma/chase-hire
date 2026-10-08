// What the candidate can do next for one application. Pure, so it is unit-tested.

export type NextStepInput = {
  role_slug: string;
  stage: string;
  status: string;
  interview: { ended_at: string | null } | null;
  quiz: { submitted_at: string | null } | null;
  work?: { app_stage: string; submitted_at: string | null; started_at: string | null }[];
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
  if (app.stage === "work_1" || app.stage === "work_2") {
    const w = app.work?.find((x) => x.app_stage === app.stage);
    if (w?.submitted_at) return null;
    const n = app.stage === "work_1" ? "1" : "2";
    return {
      href: `/apply/${app.role_slug}/work/${app.stage}`,
      label: w?.started_at ? `Continue work assessment ${n}` : `Open work assessment ${n}`,
    };
  }
  return null;
}
