import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { ReasoningResultCard } from "@/components/stars";
import { fmtDate, STAGE_LABEL, STATUS_LABEL } from "@/lib/format";

export const dynamic = "force-dynamic";

const ReviewForm = z.object({
  target: z.string().min(1),
  message: z.string().trim().min(10).max(4000),
});

async function requestReview(formData: FormData) {
  "use server";
  const { supabase } = await requireUser("/me/results");
  const parsed = ReviewForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/me/results?error=Please write at least 10 characters.");
  const [stage, applicationId] = parsed.data.target.split(":");
  const { error } = await supabase.from("review_requests").insert({
    stage,
    application_id: applicationId || null,
    message: parsed.data.message,
  });
  if (error) redirect(`/me/results?error=${encodeURIComponent("Could not send your request.")}`);
  redirect("/me/results?sent=1");
}

export default async function ResultsPage({ searchParams }: { searchParams: Promise<{ error?: string; sent?: string }> }) {
  const { supabase, user } = await requireUser("/me/results");
  const [{ data: attempts }, { data: applications }, { data: decisions }, { data: reviews }] = await Promise.all([
    supabase.from("my_reasoning").select("*").not("submitted_at", "is", null).order("started_at", { ascending: false }).limit(1),
    supabase.from("applications").select("id, stage, status, below_hurdle, created_at, roles(title)").eq("user_id", user.id),
    supabase.from("decisions").select("application_id, stage, decision, reason, decided_at").order("decided_at", { ascending: false }),
    supabase.from("review_requests").select("id, stage, message, status, response, created_at").order("created_at", { ascending: false }),
  ]);
  const reasoning = attempts?.[0];
  const { error, sent } = await searchParams;

  return (
    <div className="space-y-6">
      <h1 className="h1">My results</h1>

      {reasoning ? (
        <ReasoningResultCard
          rawScore={reasoning.raw_score}
          percentile={Number(reasoning.percentile)}
          stars={reasoning.stars}
          normVersion={reasoning.norm_version}
        />
      ) : (
        <p className="notice">
          You haven&apos;t completed the Reasoning Assessment yet. <Link href="/start" className="underline">Continue</Link>
        </p>
      )}

      <section className="card">
        <h2 className="h2">Applications</h2>
        {applications?.length ? (
          <table className="table">
            <thead>
              <tr><th>Role</th><th>Stage</th><th>Status</th><th>Applied</th></tr>
            </thead>
            <tbody>
              {applications.map((a) => (
                <tr key={a.id}>
                  <td>{(a.roles as unknown as { title: string } | null)?.title}</td>
                  <td>{STAGE_LABEL[a.stage]}</td>
                  <td>
                    {STATUS_LABEL[a.status]}
                    {decisions
                      ?.filter((d) => d.application_id === a.id)
                      .slice(0, 1)
                      .map((d) => (
                        <p key={d.decided_at} className="muted">Our reason: {d.reason}</p>
                      ))}
                  </td>
                  <td>{fmtDate(a.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No applications yet. <Link href="/roles" className="underline">See open roles</Link>.</p>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="h2">Request a review</h2>
        <p className="muted">
          You can ask a person on our team to review any score or decision, and tell us anything you think we should
          take into account. We will reply here.
        </p>
        <form action={requestReview} className="space-y-3">
          <select name="target" className="input" defaultValue="reasoning:">
            <option value="reasoning:">Reasoning Assessment</option>
            <option value="cv:">CV reading</option>
            {applications?.map((a) => (
              <option key={a.id} value={`decision:${a.id}`}>
                {(a.roles as unknown as { title: string } | null)?.title}: application
              </option>
            ))}
          </select>
          <textarea name="message" className="input" rows={4} minLength={10} maxLength={4000} required placeholder="What would you like us to review, and why?" />
          {error && <p className="error">{error}</p>}
          {sent && <p className="notice">Sent. We will reply here.</p>}
          <button className="btn">Send request</button>
        </form>
        {!!reviews?.length && (
          <ul className="space-y-2 text-sm">
            {reviews.map((r) => (
              <li key={r.id} className="rounded border border-slate-200 p-3">
                <p className="muted">{fmtDate(r.created_at)} · {r.stage} · {r.status}</p>
                <p>{r.message}</p>
                {r.response && <p className="mt-1 border-l-2 border-slate-300 pl-2">Our reply: {r.response}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
