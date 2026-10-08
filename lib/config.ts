import { z } from "zod";

/**
 * All configuration lives here. Model IDs and thresholds are config, never hard-coded at call sites.
 * Server-only values must never be read from client components.
 */

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),
});

const serverSchema = z.object({
  SUPABASE_SECRET_KEY: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_MODEL_CV_PARSE: z.string().min(1),
  OPENROUTER_MODEL_CV_VISION: z.string().min(1),
  OPENROUTER_MODEL_EMBED: z.string().min(1).default("openai/text-embedding-3-small"),
  /** Strong reasoning model for all graders (3 samples per criterion). */
  OPENROUTER_MODEL_GRADER: z.string().min(1),
  /** Cheap fast model for the BA stakeholder persona's replies. */
  OPENROUTER_MODEL_PERSONA: z.string().min(1),
  /** Writes the AI interview's follow-up questions (falls back to the persona model). */
  OPENROUTER_MODEL_INTERVIEWER: z.string().min(1).optional(),
  /** Speech-to-text for spoken interview answers. */
  OPENROUTER_MODEL_TRANSCRIBE: z.string().min(1).default("openai/whisper-1"),
  CRON_SECRET: z.string().min(16).optional(),
});

export type PublicEnv = z.infer<typeof publicSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;

export function publicEnv(): PublicEnv {
  return publicSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL || undefined,
  });
}

export function serverEnv(): ServerEnv {
  return serverSchema.parse(process.env);
}

/** Non-secret tunables. Change here, not at call sites. */
export const settings = {
  cv: {
    maxBytes: 5 * 1024 * 1024,
    mimeTypes: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ] as const,
    embeddingDimensions: 1536,
  },
  dedupe: {
    semanticHigh: 0.92,
    semanticReview: 0.85,
  },
  reasoning: {
    retakeDays: 90,
  },
} as const;
