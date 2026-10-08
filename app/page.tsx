import Link from "next/link";

export default function Home() {
  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-3xl font-semibold">Find the real problem. Build the first version. Make it work in production.</h1>
        <p className="mt-3 max-w-2xl text-slate-600">
          Chase Agents builds AI automation and operating platforms for mid-market companies. We&apos;re hiring AI-native
          Business Analysts and Software Engineers to do that work in pairs. R30,000–R32,500 a month gross plus a
          year-end profit share, remote within South Africa.
        </p>
        <div className="mt-6 flex gap-3">
          <Link href="/roles" className="btn">
            Read the roles
          </Link>
          <Link href="/signup" className="btn-secondary">
            Start your application
          </Link>
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="h2">Two roles, one team</h2>
        <p className="max-w-3xl text-slate-700">
          The business analyst sits with the client, finds what&apos;s really wrong in their data, takes a position on what
          to build and builds the first clickable version with AI tools. Then they hand it over. The software engineer
          takes that first version and its handoff pack and makes it survive production: secure, tested, deployed and
          running.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Link href="/roles/business-analyst" className="card block hover:border-slate-400">
            <h3 className="font-semibold">AI-native Business Analyst</h3>
            <p className="mt-1 text-sm text-slate-700">
              You&apos;d rather work out what&apos;s actually wrong than write down what you&apos;re told, and you want to
              build the first version yourself. Read what your day would look like.
            </p>
          </Link>
          <Link href="/roles/software-engineer" className="card block hover:border-slate-400">
            <h3 className="font-semibold">AI-native Software Engineer</h3>
            <p className="mt-1 text-sm text-slate-700">
              You take a prototype that works on someone&apos;s laptop and make it something a client can rely on. Read what
              your day would look like.
            </p>
          </Link>
        </div>
      </section>
      <section className="card">
        <h2 className="h2">How we hire, transparently</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
          <li>Create an account, read our privacy notice, and upload your CV.</li>
          <li>A 15-minute Reasoning Assessment (30 questions). You see your result straight away.</li>
          <li>Apply to a role: a spoken AI-run conversation about your CV (about 25 to 30 minutes) and a 12-minute quiz.</li>
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
