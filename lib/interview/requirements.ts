/**
 * What each role needs, in plain words (from the competencies in docs/03). The interview plan
 * matches CV claims to these, so topic questions say which part of the job a piece of work is
 * evidence for, and asks about the closest experience when the CV shows nothing for one.
 * Order matters: the first requirements are the ones the interview covers first.
 */

export interface RoleRequirement {
  key: string;
  /** Reads after "This role involves …". Lower case, no full stop. */
  text: string;
  /** Words that suggest a CV claim is evidence for it (used when JEV is unavailable). */
  keywords: readonly string[];
}

export const ROLE_REQUIREMENTS: Readonly<Record<string, readonly RoleRequirement[]>> = {
  "business-analyst": [
    {
      key: "data",
      text: "digging into messy spreadsheets and system data to find what's missing or wrong",
      keywords: ["data", "excel", "spreadsheet", "sql", "analysis", "analysed", "analyzed", "report", "dashboard", "power", "cleaned", "reconcil", "dataset", "metric"],
    },
    {
      key: "discovery",
      text: "interviewing clients and stakeholders to get to the real requirement",
      keywords: ["stakeholder", "requirement", "workshop", "interview", "client", "discovery", "elicit", "business", "process", "user"],
    },
    {
      key: "prototype",
      text: "building a first working version of a solution yourself, with AI tools or code",
      keywords: ["built", "prototype", "mvp", "app", "tool", "automat", "lovable", "bubble", "power", "script", "python", "supabase", "low-code", "no-code"],
    },
    {
      key: "recommendation",
      text: "researching a problem and recommending what to do, and what not to do",
      keywords: ["recommend", "research", "strategy", "proposal", "business case", "insight", "decision", "advis", "assessment"],
    },
    {
      key: "handoff",
      text: "writing requirements or specs that developers can build from",
      keywords: ["spec", "user stor", "acceptance", "requirement", "documentation", "brd", "frd", "jira", "backlog", "handover"],
    },
  ],
  "software-engineer": [
    {
      key: "hardening",
      text: "taking an existing app and making it secure and production-ready",
      keywords: ["security", "secure", "auth", "rls", "permission", "production", "refactor", "migrat", "test", "harden", "legacy"],
    },
    {
      key: "fullstack",
      text: "building features end to end: interface, API and database",
      keywords: ["react", "next", "typescript", "node", "api", "frontend", "backend", "full-stack", "fullstack", "postgres", "database", "feature"],
    },
    {
      key: "data",
      text: "building data imports or pipelines that cope with messy data",
      keywords: ["pipeline", "etl", "import", "ingest", "data", "csv", "integration", "sync", "batch", "queue"],
    },
    {
      key: "ops",
      text: "deploying and running software in production: CI, monitoring and fixing it when it breaks",
      keywords: ["deploy", "ci", "cd", "aws", "azure", "gcp", "vercel", "docker", "kubernetes", "monitor", "incident", "uptime", "devops"],
    },
    {
      key: "architecture",
      text: "designing a system and working out what it will cost to run",
      keywords: ["architect", "design", "cost", "scal", "system", "infrastructure", "budget", "vendor"],
    },
  ],
};

const GENERIC_REQUIREMENTS: readonly RoleRequirement[] = [
  { key: "core", text: "the day-to-day work described in the job description", keywords: [] },
];

export function requirementsFor(slug: string): readonly RoleRequirement[] {
  return ROLE_REQUIREMENTS[slug] ?? GENERIC_REQUIREMENTS;
}

/** How many requirements the plan tries to cover with their own topic. */
export const REQUIREMENT_TOPICS = 3;
