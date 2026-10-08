import { defineConfig, devices } from "@playwright/test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { localSupabaseEnv } = require("./tests/helpers/local-env.cjs");

// Critical candidate path against a local Supabase stack and a stub OpenRouter.
// Prereq: `npx supabase start`. Run: `npm run test:e2e`.
const sb = localSupabaseEnv();
const local = {
  NEXT_PUBLIC_SUPABASE_URL: sb.url,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: sb.publishable,
  SUPABASE_SECRET_KEY: sb.secret,
  NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
  OPENROUTER_API_KEY: "stub",
  OPENROUTER_BASE_URL: "http://127.0.0.1:4010",
  OPENROUTER_MODEL_CV_PARSE: "stub/cv-parse",
  OPENROUTER_MODEL_CV_VISION: "stub/cv-vision",
  OPENROUTER_MODEL_EMBED: "stub/embed",
  OPENROUTER_MODEL_GRADER: "stub/grader",
  OPENROUTER_MODEL_PERSONA: "stub/persona",
  TYPESAFE_API_KEY: "stub",
  TYPESAFE_BASE_URL: "http://127.0.0.1:4010",
  CRON_SECRET: "e2e-cron-secret-123456",
};

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    // A fake microphone for the spoken AI interview (the stub transcribes any real recording).
    permissions: ["microphone"],
    launchOptions: {
      ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    { command: "node tests/stubs/ai-stub.mjs", url: "http://127.0.0.1:4010/health", reuseExistingServer: true },
    {
      command: "npx next build && npx next start -p 3000",
      url: "http://localhost:3000",
      reuseExistingServer: true,
      timeout: 400_000,
      env: local,
    },
  ],
});
