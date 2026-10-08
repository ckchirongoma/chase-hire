// The candidate's journey through one application, as steps grouped into sections, for the
// left-to-right diagram on the results page. Pure, so it is unit-tested.

export type StepState = "done" | "current" | "review" | "upcoming" | "stopped";

export type JourneyStep = { key: string; label: string; state: StepState };
export type JourneySection = { title: string; steps: JourneyStep[] };

export type JourneyInput = {
  role_slug: string;
  stage: string;
  status: string;
  interview: { ended_at: string | null } | null;
  quiz: { submitted_at: string | null } | null;
  work: { app_stage: string; title: string; submitted_at: string | null }[];
};

const WORK_TITLES: Record<string, [string, string]> = {
  "business-analyst": ["Discovery & point of view", "Build & handoff"],
  "software-engineer": ["Harden & ship", "Architecture & cost plan"],
};

/** Which step index each application stage sits on (reasoning is step 0, done before applying). */
const STAGE_STEP: Record<string, number> = {
  interview: 1,
  quiz: 2,
  work_1: 3,
  work_2: 4,
  grading: 4,
  shortlist: 5,
  live: 5,
  offer: 6,
};

const CLOSED = ["rejected", "withdrawn", "lapsed"];

/** True when the candidate has finished the work of the step their application is on. */
function finishedCurrent(app: JourneyInput): boolean {
  if (app.stage === "interview") return !!app.interview?.ended_at;
  if (app.stage === "quiz") return !!app.quiz?.submitted_at;
  if (app.stage === "work_1" || app.stage === "work_2") return !!app.work.find((w) => w.app_stage === app.stage)?.submitted_at;
  return app.stage === "grading";
}

export function journey(app: JourneyInput): JourneySection[] {
  const [w1, w2] = WORK_TITLES[app.role_slug] ?? ["Work assessment 1", "Work assessment 2"];
  const labels = ["Reasoning Assessment", "AI CV interview", "Role quiz", w1, w2, "Live session with our team", "Decision"];
  const keys = ["reasoning", "interview", "quiz", "work_1", "work_2", "live", "decision"];
  const closed = CLOSED.includes(app.status) || app.stage === "closed";
  // A closed application stops at the last stage it reached (closed rows keep their stage).
  const cur = STAGE_STEP[app.stage] ?? (closed ? 1 : 6);
  const waiting = app.status === "awaiting_review" || app.status === "submitted" || finishedCurrent(app);

  const state = (i: number): StepState => {
    if (i < cur) return "done";
    if (i > cur) return "upcoming";
    if (closed) return "stopped";
    if (app.stage === "offer" && app.status === "advanced") return "done";
    return waiting ? "review" : "current";
  };
  const steps = labels.map((label, i) => ({ key: keys[i], label, state: state(i) }));
  return [
    { title: "Work readiness", steps: steps.slice(0, 3) },
    { title: "Work assessment", steps: steps.slice(3, 5) },
    { title: "Real work with us", steps: steps.slice(5) },
  ];
}

/** How long the next step takes, so candidates can plan a break before it. */
export function stepDuration(roleSlug: string, stage: string): string | null {
  if (stage === "interview") return "A spoken conversation of about 25 to 30 minutes.";
  if (stage === "quiz") return "15 questions in 12 minutes.";
  const work: Record<string, Record<string, string>> = {
    "business-analyst": {
      work_1: "About 3 hours of work in a 4-hour window, which starts when you press Start.",
      work_2: "About 4 hours of work in a 48-hour window, which starts when you press Start.",
    },
    "software-engineer": {
      work_1: "About 6 hours of work in a 72-hour window, which starts when you press Start.",
      work_2: "About 3 to 4 hours of work in a 24-hour window, which starts when you press Start.",
    },
  };
  return work[roleSlug]?.[stage] ?? null;
}
