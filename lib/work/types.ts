import type { StageMaterials } from "./gdoc";
import type { Draft } from "./schema";
import type { AppStage, StageKey } from "./stages";

/**
 * What the candidate's work page sees (from /api/work/... and the page's server render).
 * Never includes rubric material, dataset internals or grading evidence.
 *
 * status:
 *   unavailable  not at this stage (or not applied); nothing to do here yet
 *   held         a person on our team is reviewing the application before it can start
 *   closed       the application is closed (rejected, withdrawn or lapsed)
 *   ready        unlocked; press Start before open_until
 *   expired      the open window closed without a Start
 *   active       started; submit before deadline_at
 *   late         the work window ended without a submission
 *   submitted    submitted; graded in the background, people decide
 */
export type WorkStatus = "unavailable" | "held" | "closed" | "ready" | "expired" | "active" | "late" | "submitted";

export interface WorkStageView {
  key: StageKey;
  title: string;
  appStage: AppStage;
  roleSlug: string;
  briefMd: string;
  intendedEffort: string;
  workWindowMs: number | null;
  openWindowMs: number | null;
  wordLimit: number | null;
  pageLimit: number | null;
  hasPersona: boolean;
  hasDatasets: boolean;
  /** Instructions and answer-template links (Google Docs), for stages answered in a template copy. */
  materials: StageMaterials;
}

export interface WorkAttemptView {
  id: string;
  unlockedAt: string;
  openUntil: string;
  startedAt: string | null;
  deadlineAt: string | null;
  submittedAt: string | null;
  draft: Draft;
  draftSavedAt: string | null;
}

export interface WorkSubmissionView {
  submittedAt: string;
  files: { name: string }[];
  links: { name: string; url: string }[];
  wordCount: number | null;
  pageCount: number | null;
  gradingStatus: string;
}

export interface WorkView {
  status: WorkStatus;
  stage: WorkStageView;
  attempt: WorkAttemptView | null;
  submission: WorkSubmissionView | null;
  applicationStatus: string | null;
  notice: string | null;
  serverNow: string;
}

export interface DatasetFile {
  /** Path under the bundle's candidate/ folder, e.g. "kopano_vsam_extract.xlsx". */
  name: string;
  size: number | null;
  url: string;
  expiresAt: string;
}
