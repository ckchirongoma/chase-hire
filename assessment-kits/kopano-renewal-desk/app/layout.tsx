import type { Metadata } from "next";
import Link from "next/link";
import { getCaller } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "Renewal Desk",
  description: "Kopano Connect Virtual Sales renewal desk",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const caller = await getCaller().catch(() => null);
  return (
    <html lang="en">
      <body>
        <header className="border-b border-slate-200 bg-white">
          <nav className="mx-auto flex max-w-6xl items-center gap-5 px-4 py-3 text-sm">
            <Link href="/queue" className="font-semibold">
              Renewal Desk
            </Link>
            {caller && (
              <>
                <Link href="/queue">Queue</Link>
                {caller.isManager && <Link href="/manager">Exceptions</Link>}
                {caller.isManager && <Link href="/import">Import</Link>}
                <span className="ml-auto muted">
                  {caller.name} ({caller.role})
                </span>
                <form action="/auth/signout" method="post">
                  <button className="btn-secondary" type="submit">
                    Sign out
                  </button>
                </form>
              </>
            )}
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
