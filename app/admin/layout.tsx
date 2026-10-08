import Link from "next/link";
import { requireAdmin } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-4 text-sm">
        <span className="font-semibold">Admin</span>
        <Link href="/admin/candidates" className="underline">Candidates</Link>
        <Link href="/admin/dedupe" className="underline">Dedupe</Link>
        <Link href="/admin/roles" className="underline">Roles</Link>
        <Link href="/admin/banks" className="underline">Reasoning bank</Link>
        <Link href="/admin/quiz-bank" className="underline">Quiz bank</Link>
        <Link href="/admin/rubrics" className="underline">Rubrics</Link>
      </nav>
      {children}
    </div>
  );
}
