import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import path from "node:path";

/**
 * `npm test` runs the unit tests (no database needed).
 * `npm run test:db` also runs the database tests against the local Supabase stack
 * (`npx supabase start`). They WIPE the business tables first: re-run `npm run seed` afterwards.
 */
export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
      "server-only": path.resolve(import.meta.dirname, "tests/helpers/empty.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: { ...loadEnv("test", process.cwd(), ""), ...loadEnv("development", process.cwd(), ""), RUN_DB_TESTS: mode === "db" ? "1" : "" },
    // Database tests share one database: run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
}));
