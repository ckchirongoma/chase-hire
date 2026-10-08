import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Local Supabase stack (`npx supabase start`); keys are read from `supabase status`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { localSupabaseEnv } = require("./local-env.cjs") as {
  localSupabaseEnv: () => { url: string; publishable: string; secret: string; dbUrl: string; mailpit: string };
};
export const LOCAL = localSupabaseEnv();

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

export const service = () => createClient(LOCAL.url, LOCAL.secret, noSession);
export const anon = () => createClient(LOCAL.url, LOCAL.publishable, noSession);

let counter = 0;
export function uniqueEmail(tag: string) {
  return `${tag}.${Date.now()}.${counter++}@example.co.za`;
}

/** Creates a confirmed user and returns a client signed in as them. */
export async function newUser(tag = "user"): Promise<{ id: string; email: string; client: SupabaseClient }> {
  const email = uniqueEmail(tag);
  const password = "test-password-123";
  const { data, error } = await service().auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  const client = createClient(LOCAL.url, LOCAL.publishable, noSession);
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
  if (signInErr) throw signInErr;
  return { id: data.user.id, email, client };
}

export async function makeAdmin(userId: string) {
  const { error } = await service().from("admins").insert({ user_id: userId });
  if (error) throw error;
}

/** Runs SQL as the postgres superuser (for test setup that the API deliberately forbids). */
export function psql(sql: string): string {
  return execFileSync("psql", [LOCAL.dbUrl, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], { encoding: "utf8" });
}

export async function consent(client: SupabaseClient) {
  const { error } = await client.from("consents").insert({
    notice_version: "test",
    accepted_processing: true,
    accepted_ai_assessment: true,
    accepted_offshore_processing: true,
  });
  if (error) throw error;
}

/** Inserts a parsed CV row directly (bypasses the AI pipeline). */
export async function fakeParsedCv(userId: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await service()
    .from("cvs")
    .insert({
      user_id: userId,
      storage_path: `${userId}/${Date.now()}-${counter++}.pdf`,
      file_name: "cv.pdf",
      mime: "application/pdf",
      size_bytes: 1000,
      file_sha256: `sha-${userId}`,
      status: "parsed",
      parsed: { identity: {} },
      ...extra,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

/** Inserts a finished reasoning attempt with the given stars. */
export async function fakeFinishedAttempt(userId: string, stars: number) {
  const { data, error } = await service()
    .from("reasoning_attempts")
    .insert({ user_id: userId, seed: 1, deadline_at: new Date(Date.now() + 60_000).toISOString() })
    .select("id")
    .single();
  if (error) throw error;
  const { error: upErr } = await service()
    .from("reasoning_attempts")
    .update({ submitted_at: new Date().toISOString(), raw_score: 10, percentile: 30, stars, norm_version: "test" })
    .eq("id", data.id);
  if (upErr) throw upErr;
  return data.id as string;
}
