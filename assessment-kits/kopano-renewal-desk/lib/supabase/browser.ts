import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser client: the project URL and the publishable key only (both public by design; RLS
 * protects the data). Used to sign in, which stores the session in cookies the server reads.
 * Never put a server key here or in any NEXT_PUBLIC_ variable.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set (see .env.example)");
  return createBrowserClient(url, key);
}
