import { defineConfig } from "vitest/config";
import path from "node:path";

// Runs against a local Supabase stack (`npx supabase start`). See README.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
      "server-only": path.resolve(import.meta.dirname, "tests/helpers/empty.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/helpers/ai-stub-setup.ts"],
    setupFiles: ["tests/helpers/ai-stub-env.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
