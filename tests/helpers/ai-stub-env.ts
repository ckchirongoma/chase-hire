// Per-worker env for integration tests: point the app at the local Supabase stack and at
// the offline AI/JEV stub started in ai-stub-setup.ts.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { localSupabaseEnv } = require("./local-env.cjs") as {
  localSupabaseEnv: () => { url: string; publishable: string; secret: string };
};

const PORT = 4011;
const sb = localSupabaseEnv();
Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: sb.url,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: sb.publishable,
  SUPABASE_SECRET_KEY: sb.secret,
  OPENROUTER_API_KEY: "stub",
  OPENROUTER_BASE_URL: `http://127.0.0.1:${PORT}`,
  OPENROUTER_MODEL_CV_PARSE: "stub/cv-parse",
  OPENROUTER_MODEL_CV_VISION: "stub/cv-vision",
  OPENROUTER_MODEL_EMBED: "stub/embed",
  OPENROUTER_MODEL_GRADER: "stub/grader",
  OPENROUTER_MODEL_PERSONA: "stub/persona",
  TYPESAFE_API_KEY: "stub",
  TYPESAFE_BASE_URL: `http://127.0.0.1:${PORT}`,
  CRON_SECRET: "integration-cron-secret",
});
