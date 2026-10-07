// Reads the local Supabase stack's URLs and keys from `supabase status` so no keys
// are committed. Env vars (LOCAL_SUPABASE_*) take precedence.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execSync } = require("node:child_process");

let cached;
function localSupabaseEnv() {
  if (cached) return cached;
  let status = {};
  try {
    const out = execSync("npx supabase status -o env", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split("\n")) {
      const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
      if (m) status[m[1]] = m[2];
    }
  } catch {
    // stack not running; rely on env vars
  }
  cached = {
    url: process.env.LOCAL_SUPABASE_URL ?? status.API_URL ?? "http://127.0.0.1:54321",
    publishable: process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY ?? status.PUBLISHABLE_KEY ?? "",
    secret: process.env.LOCAL_SUPABASE_SECRET_KEY ?? status.SECRET_KEY ?? "",
    dbUrl: process.env.LOCAL_DB_URL ?? status.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    mailpit: process.env.LOCAL_MAILPIT_URL ?? status.MAILPIT_URL ?? "http://127.0.0.1:54324",
  };
  if (!cached.publishable || !cached.secret) {
    throw new Error("Local Supabase keys not found. Run `npx supabase start` first.");
  }
  return cached;
}

module.exports = { localSupabaseEnv };
