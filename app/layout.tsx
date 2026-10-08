import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getUser, isAdmin } from "@/lib/server/auth";

export const metadata: Metadata = {
  title: "Chase Agents Careers",
  description: "Apply to Chase Agents: AI-native Business Analyst and Software Engineer roles.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { supabase, user } = await getUser();
  const admin = user ? await isAdmin(supabase) : false;
  return (
    <html lang="en">
      <body className="antialiased">
        <header className="border-b border-slate-200 bg-white">
          <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-4 py-3 text-sm">
            <Link href="/" className="font-semibold">
              Chase Agents Careers
            </Link>
            <Link href="/roles">Roles</Link>
            {user && <Link href="/me/results">My results</Link>}
            {admin && <Link href="/admin/candidates">Admin</Link>}
            <span className="ml-auto" />
            {user ? (
              <form action="/auth/signout" method="post">
                <span className="mr-3 text-slate-500">{user.email}</span>
                <button className="underline">Log out</button>
              </form>
            ) : (
              <>
                <Link href="/login">Log in</Link>
                <Link href="/signup" className="btn">
                  Sign up
                </Link>
              </>
            )}
          </nav>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
        <footer className="mx-auto max-w-5xl px-4 pb-8 text-xs text-slate-500">
          <Link href="/privacy" className="underline">
            Privacy notice
          </Link>
        </footer>
      </body>
    </html>
  );
}
