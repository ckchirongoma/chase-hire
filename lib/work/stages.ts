/**
 * Work-assessment stages (docs/01 §5, docs/06-08): keys, file slots and form fields.
 * Pure and client-safe: the submission form and the server-side validation share these.
 */

export const STAGE_KEYS = ["ba_part1", "ba_part2", "swe_test1", "swe_test2"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export const APP_STAGES = ["work_1", "work_2"] as const;
export type AppStage = (typeof APP_STAGES)[number];

export function isStageKey(v: unknown): v is StageKey {
  return typeof v === "string" && (STAGE_KEYS as readonly string[]).includes(v);
}

export function isAppStage(v: unknown): v is AppStage {
  return typeof v === "string" && (APP_STAGES as readonly string[]).includes(v);
}

/** Submissions and autosaves are accepted for this long after deadline_at (the DB allows 5 s). */
export const WORK_GRACE_MS = 5000;
/** Signed dataset links live this long (seconds). */
export const DATASET_URL_TTL_S = 600;
/** Autosaved drafts are capped at about 50 KB of JSON. */
export const DRAFT_MAX_BYTES = 50_000;
export const AUTOSAVE_INTERVAL_MS = 20_000;
/** The submissions bucket's own limit is 20 MB per file. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_EXTRA_FILES = 5;
export const MAX_TRANSCRIPT_CHARS = 40_000;
/** Pages are estimated at 500 words each for DOCX and Markdown (PDF pages are counted). */
export const WORDS_PER_PAGE = 500;

export type FileExt = "pdf" | "docx" | "md" | "txt" | "png" | "jpg" | "jpeg";

export const EXT_MIME: Record<FileExt, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown",
  txt: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/** Documents we can read text from; images are stored for a human only. */
export const TEXT_EXTS: readonly FileExt[] = ["pdf", "docx", "md", "txt"];

export type FileField = {
  kind: "file";
  name: string;
  label: string;
  help?: string;
  exts: readonly FileExt[];
  required: boolean;
  /** More than one file allowed (up to MAX_EXTRA_FILES). */
  multiple?: boolean;
  /** Counts towards the stage's word or page limit. */
  main?: boolean;
};

export type TextField = {
  kind: "url" | "repo" | "text" | "transcript" | "gdoc";
  name: "mvp_url" | "repo_url" | "deployed_url" | "loom_url" | "loom_transcript" | "test_logins" | "doc_url";
  label: string;
  help?: string;
  required: boolean;
  placeholder?: string;
  /** A Google Doc link whose copy (downloaded at submission) is the stage's main document. */
  main?: boolean;
};

export type FieldDef = FileField | TextField;

const LOOM: TextField[] = [
  {
    kind: "url",
    name: "loom_url",
    label: "Loom link",
    help: "The share link of your 5-minute Loom (https://…).",
    required: true,
    placeholder: "https://www.loom.com/share/…",
  },
  {
    kind: "transcript",
    name: "loom_transcript",
    label: "Loom transcript",
    help: "Paste the Loom auto-transcript (in Loom: open the video, then Transcript, then copy). Graders read it alongside the video.",
    required: true,
  },
];

export const STAGE_FIELDS: Record<StageKey, readonly FieldDef[]> = {
  ba_part1: [
    {
      kind: "gdoc",
      name: "doc_url",
      label: "Link to your copy of the answer template",
      help: "Your own copy (Make a copy), shared as “Anyone with the link → Viewer”. At most 1,500 words before Appendix A. We save a copy of it when you submit.",
      required: true,
      placeholder: "https://docs.google.com/document/d/…",
      main: true,
    },
  ],
  ba_part2: [
    {
      kind: "url",
      name: "mvp_url",
      label: "Clickable MVP link",
      help: "The hosted MVP, running on the provided data (https://…).",
      required: true,
      placeholder: "https://…",
    },
    {
      kind: "gdoc",
      name: "doc_url",
      label: "Link to your copy of the handoff template",
      help: "Your own copy (Make a copy), shared as “Anyone with the link → Viewer”. Put the data model (table definitions and grain) in it, or add the ERD as an extra file. We save a copy of it when you submit.",
      required: true,
      placeholder: "https://docs.google.com/document/d/…",
      main: true,
    },
    {
      kind: "file",
      name: "extras",
      label: "Extra files (optional)",
      help: "For example the ERD as an image, or Mermaid in a Markdown file. Up to 5 files.",
      exts: ["png", "jpg", "jpeg", "pdf", "docx", "md"],
      required: false,
      multiple: true,
    },
    ...LOOM,
  ],
  swe_test1: [
    {
      kind: "repo",
      name: "repo_url",
      label: "Repository URL",
      help: "https://github.com/owner/repo. We record the commit SHA at submission and grade that commit.",
      required: true,
      placeholder: "https://github.com/owner/repo",
    },
    {
      kind: "url",
      name: "deployed_url",
      label: "Deployed URL",
      required: true,
      placeholder: "https://…",
    },
    {
      kind: "text",
      name: "test_logins",
      label: "Test logins",
      help:
        "One per line: \"agent: email / password\" (twice) and \"manager: email / password\". If your app only talks to Supabase on the server, add \"supabase: <project URL> / <publishable key>\".",
      required: true,
    },
    ...LOOM,
  ],
  swe_test2: [
    {
      kind: "file",
      name: "memo",
      label: "Your memo",
      help: "PDF, DOCX or Markdown, at most 6 pages including diagrams (DOCX and Markdown are counted at 500 words a page).",
      exts: ["pdf", "docx", "md"],
      required: true,
      main: true,
    },
    ...LOOM,
  ],
};

export function fileFields(key: StageKey): FileField[] {
  return STAGE_FIELDS[key].filter((f): f is FileField => f.kind === "file");
}

export function textFields(key: StageKey): TextField[] {
  return STAGE_FIELDS[key].filter((f): f is TextField => f.kind !== "file");
}

/** Lower-case extension of a file name or storage path, or null. */
export function extOf(name: string): FileExt | null {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = m?.[1];
  return ext && ext in EXT_MIME ? (ext as FileExt) : null;
}

/** A storage-safe file name: ASCII letters, digits, dot, dash and underscore only. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const ext = extOf(base);
  const stem = base
    .replace(/\.[^.]*$/, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80);
  return `${stem || "file"}${ext ? `.${ext}` : ""}`;
}

/** The name a candidate gave a file, from its storage path ({user}/{attempt}/{ms}-{name}). */
export function displayName(path: string): string {
  const last = path.split("/").pop() ?? path;
  return last.replace(/^\d{10,}-/, "");
}

/** Where the browser uploads a work file: submissions/{userId}/{attemptId}/{timestamp}-{safe name}. */
export function uploadPath(userId: string, attemptId: string, fileName: string, now = Date.now()): string {
  return `${userId}/${attemptId}/${now}-${safeFileName(fileName)}`;
}

/** The field holding the stage's main document (a file upload or a Google Doc link), if any. */
export function mainFieldName(key: StageKey): string | null {
  return STAGE_FIELDS[key].find((f) => f.main)?.name ?? null;
}

export function gdocField(key: StageKey): TextField | null {
  return textFields(key).find((f) => f.kind === "gdoc") ?? null;
}
