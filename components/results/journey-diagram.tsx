import type { JourneySection, StepState } from "./journey";

const CIRCLE: Record<StepState, string> = {
  done: "bg-emerald-600 text-white border-emerald-600",
  current: "bg-white text-slate-900 border-slate-900 ring-4 ring-slate-200",
  review: "bg-amber-400 text-slate-900 border-amber-400",
  upcoming: "bg-white text-slate-400 border-slate-300",
  stopped: "bg-slate-400 text-white border-slate-400",
};

const STATE_LABEL: Record<StepState, string> = {
  done: "Done",
  current: "Your next step",
  review: "With our team",
  upcoming: "Later",
  stopped: "Closed",
};

/** Left-to-right circles for one application, grouped into sections. */
export function JourneyDiagram({ sections }: { sections: JourneySection[] }) {
  let n = 0;
  return (
    <div className="overflow-x-auto pb-1" data-testid="journey">
      <ol className="flex min-w-max items-start gap-0">
        {sections.map((section, si) => (
          <li key={section.title} className="flex items-start">
            <div className="space-y-2">
              <p className="px-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{section.title}</p>
              <ol className="flex items-start">
                {section.steps.map((step, i) => {
                  n += 1;
                  const last = si === sections.length - 1 && i === section.steps.length - 1;
                  return (
                    <li key={step.key} className="flex items-start" data-state={step.state} data-step={step.key}>
                      <div className="flex w-28 flex-col items-center text-center">
                        <span
                          className={`flex h-10 w-10 items-center justify-center rounded-full border-2 text-sm font-semibold ${CIRCLE[step.state]}`}
                          aria-hidden="true"
                        >
                          {step.state === "done" ? "✓" : n}
                        </span>
                        <span className="mt-2 text-xs font-medium leading-tight text-slate-800">{step.label}</span>
                        <span className={`mt-0.5 text-[11px] ${step.state === "current" ? "font-semibold text-slate-900" : "text-slate-500"}`}>
                          {STATE_LABEL[step.state]}
                        </span>
                        <span className="sr-only">
                          Step {n}: {step.label}, {STATE_LABEL[step.state]}
                        </span>
                      </div>
                      {!last && (
                        <span
                          className={`mt-5 h-0.5 w-6 shrink-0 ${step.state === "done" ? "bg-emerald-600" : "bg-slate-200"}`}
                          aria-hidden="true"
                        />
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
