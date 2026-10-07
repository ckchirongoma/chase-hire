/** Rand formatting, e.g. R30,000. */
export function rands(n: number): string {
  return `R${Math.round(n).toLocaleString("en-US")}`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Johannesburg" });
}

export const STATUS_LABEL: Record<string, string> = {
  in_progress: "In progress",
  submitted: "Submitted",
  awaiting_review: "Waiting for our team to review",
  advanced: "Advanced",
  rejected: "Not progressing",
  withdrawn: "Withdrawn",
  lapsed: "Window closed",
};

export const STAGE_LABEL: Record<string, string> = {
  interview: "AI CV interview",
  quiz: "Role quiz",
  work_1: "Work assessment 1",
  work_2: "Work assessment 2",
  grading: "Grading",
  shortlist: "Shortlist",
  live: "Live session",
  offer: "Offer",
  closed: "Closed",
};
