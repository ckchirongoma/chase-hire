// Role quiz blueprint (doc 05 Part B): 15 items in 12 minutes, stratified by topic.
// The deadline itself is set by the DB trigger on quiz_attempts; these constants are
// for display and for the server-side lazy finalise check.

export const QUIZ_ITEM_COUNT = 15;
export const QUIZ_DURATION_MS = 12 * 60 * 1000;
/** Allowance for network latency on the final answer (matches the DB guard). */
export const QUIZ_GRACE_MS = 5000;

export const QUIZ_ROLES = ["software-engineer", "business-analyst"] as const;
export type QuizRole = (typeof QUIZ_ROLES)[number];

export type BlueprintEntry = { topic: string; count: number };

/** Items per topic for one attempt, in the doc 05 topic order. Each role totals 15. */
export const BLUEPRINT: Record<QuizRole, readonly BlueprintEntry[]> = {
  "software-engineer": [
    { topic: "postgres_sql", count: 3 },
    { topic: "supabase_security", count: 3 },
    { topic: "nextjs_vercel", count: 2 },
    { topic: "data_engineering", count: 2 },
    { topic: "web_security", count: 2 },
    { topic: "ai_integration", count: 2 },
    { topic: "ops", count: 1 },
  ],
  "business-analyst": [
    { topic: "elicitation", count: 3 },
    { topic: "data_literacy", count: 4 },
    { topic: "requirements", count: 3 },
    { topic: "process_metrics", count: 2 },
    { topic: "compliance", count: 2 },
    { topic: "ai_judgement", count: 1 },
  ],
};

/** The bank should hold at least this many active items per blueprint slot, to limit exposure. */
export const BANK_DEPTH_TARGET = 4;

export const TOPIC_LABEL: Record<string, string> = {
  postgres_sql: "Postgres & SQL",
  supabase_security: "Supabase security",
  nextjs_vercel: "Next.js & Vercel",
  data_engineering: "Data engineering",
  web_security: "Web security",
  ai_integration: "AI integration",
  ops: "Ops",
  elicitation: "Elicitation & stakeholders",
  data_literacy: "Data literacy",
  requirements: "Requirements",
  process_metrics: "Process & metrics",
  compliance: "Compliance basics",
  ai_judgement: "AI tool judgement",
};

export function isQuizRole(slug: string): slug is QuizRole {
  return (QUIZ_ROLES as readonly string[]).includes(slug);
}

/** Topic keys for a role in display order (empty for an unknown role). */
export function topicsFor(slug: string): string[] {
  return isQuizRole(slug) ? BLUEPRINT[slug].map((b) => b.topic) : [];
}

export function topicLabel(topic: string): string {
  return TOPIC_LABEL[topic] ?? topic.replace(/_/g, " ");
}
