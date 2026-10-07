import { NOTICE_SECTIONS, NOTICE_VERSION } from "@/lib/consent/notice";

export default function PrivacyPage() {
  return (
    <article className="card space-y-4">
      <h1 className="h1">Privacy notice for applicants</h1>
      <p className="muted">Version {NOTICE_VERSION}</p>
      {NOTICE_SECTIONS.map((s) => (
        <section key={s.title}>
          <h2 className="h2">{s.title}</h2>
          {s.body.map((p, i) => (
            <p key={i} className="mb-2 text-sm text-slate-700">{p}</p>
          ))}
        </section>
      ))}
    </article>
  );
}
