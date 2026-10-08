import "server-only";
import { redirect } from "next/navigation";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { publicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export type Role = "agent" | "manager" | "admin";

export interface Caller {
  userId: string;
  email: string | null;
  name: string;
  role: Role;
  isManager: boolean;
  /** Acts as this user: every query goes through RLS. */
  db: SupabaseClient;
}

/** A client for an API caller that sends `Authorization: Bearer <access token>`. */
function bearerClient(token: string): SupabaseClient {
  const env = publicEnv();
  return createSupabaseClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/**
 * The signed-in user behind a request (cookie session from the app, or a bearer token for API
 * clients), with their Desk role. Null when not signed in or not a Desk user.
 */
export async function getCaller(req?: Request): Promise<Caller | null> {
  const header = req?.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  let db: SupabaseClient;
  if (token) db = bearerClient(token);
  else {
    try {
      db = await createClient();
    } catch {
      return null; // no request scope (e.g. a handler called directly): no cookie session
    }
  }
  const { data, error } = token ? await db.auth.getUser(token) : await db.auth.getUser();
  if (error || !data.user) return null;
  const { data: agent } = await db.from("agents").select("name, role").eq("id", data.user.id).maybeSingle();
  if (!agent) return null;
  const role = agent.role as Role;
  return { userId: data.user.id, email: data.user.email ?? null, name: agent.name, role, isManager: role === "manager" || role === "admin", db };
}

/** For pages: the caller, or a redirect to the login page. */
export async function requireCaller(): Promise<Caller> {
  const caller = await getCaller();
  if (!caller) redirect("/login");
  return caller;
}

export async function requireManager(): Promise<Caller> {
  const caller = await requireCaller();
  if (!caller.isManager) redirect("/queue");
  return caller;
}
