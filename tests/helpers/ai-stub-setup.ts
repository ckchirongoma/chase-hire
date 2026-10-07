// Vitest globalSetup for integration tests: starts the offline AI/JEV stub and points
// the app's OpenRouter and JEV clients at it.
const PORT = 4011;

export default async function setup() {
  const { start } = await import("../stubs/ai-stub.mjs");
  const server = await start(PORT);
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

