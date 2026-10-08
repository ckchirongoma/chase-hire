"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const Login = z.object({ email: z.email(), password: z.string().min(1).max(200) });

export async function signIn(_prev: { error: string | null }, form: FormData): Promise<{ error: string | null }> {
  const parsed = Login.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return { error: "Enter your email address and password." };
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: "That email and password do not match a Desk login." };
  redirect("/queue");
}
