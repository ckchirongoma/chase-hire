import Link from "next/link";

export default function Home() {
  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-3xl font-semibold">Build real client systems from week one.</h1>
        <p className="mt-3 max-w-2xl text-slate-600">
          Chase Agents builds AI automation and operating platforms for mid-market companies. We are hiring
          AI-native Business Analysts and Software Engineers. R30,000–R32,500 a month plus a year-end profit share,
          remote within South Africa.
        </p>
        <div className="mt-6 flex gap-3">
          <Link href="/signup" className="btn">
            Start your application
          </Link>
          <Link href="/roles" className="btn-secondary">
            See the roles
          </Link>
        </div>
      </section>
      <section className="card">
        <h2 className="h2">How we hire, transparently</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
          <li>Create an account, read our privacy notice, and upload your CV.</li>
          <li>A 15-minute Reasoning Assessment (30 questions). You see your result straight away.</li>
          <li>Apply to a role: a short AI-run CV interview and a 12-minute quiz.</li>
          <li>Two practical work assessments, with the time and effort stated up front.</li>
          <li>Shortlisted candidates do a live session with our team.</li>
        </ol>
        <p className="mt-3 muted">
          You see your scores at every stage and can ask a person to review any of them. People, not software, make
          every hiring decision.
        </p>
      </section>
    </div>
  );
}
