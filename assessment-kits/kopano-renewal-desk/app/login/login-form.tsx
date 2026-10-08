"use client";

import { useState } from "react";
import { z } from "zod";
import { createClient } from "@/lib/supabase/browser";

const Login = z.object({ email: z.email(), password: z.string().min(1).max(200) });

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const parsed = Login.safeParse({ email: form.get("email"), password: form.get("password") });
    if (!parsed.success) {
      setError("Enter your email address and password.");
      return;
    }
    setPending(true);
    const { error: signInError } = await createClient().auth.signInWithPassword(parsed.data);
    if (signInError) {
      setPending(false);
      setError("That email and password do not match a Desk login.");
      return;
    }
    // The session is now in cookies. A full page load (not a client-side transition) makes sure no
    // page prefetched while signed out is reused.
    window.location.assign("/queue");
  }

  return (
    // method="post": even without JavaScript the password never ends up in a URL.
    <form onSubmit={submit} method="post" className="card max-w-sm space-y-4">
      <div>
        <label className="label" htmlFor="email">
          Email
        </label>
        <input className="input" id="email" name="email" type="email" autoComplete="username" required />
      </div>
      <div>
        <label className="label" htmlFor="password">
          Password
        </label>
        <input className="input" id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {error && <p className="error">{error}</p>}
      <button className="btn w-full" disabled={pending} type="submit">
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
