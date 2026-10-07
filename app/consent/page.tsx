import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { NOTICE_SECTIONS, NOTICE_VERSION } from "@/lib/consent/notice";
import { getCandidateState, requireUser } from "@/lib/server/auth";

const ConsentForm = z.object({
  accepted_processing: z.literal("on"),
  accepted_ai_assessment: z.literal("on"),
  accepted_offshore_processing: z.literal("on"),
  talent_pool_opt_in: z.literal("on").optional(),
});

async function acceptConsent(formData: FormData) {
  "use server";
  const { supabase } = await requireUser("/consent");
  const parsed = ConsentForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/consent?error=required");

  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
  const { error } = await supabase.from("consents").insert({
    notice_version: NOTICE_VERSION,
    accepted_processing: true,
    accepted_ai_assessment: true,
    accepted_offshore_processing: true,
    talent_pool_opt_in: parsed.data.talent_pool_opt_in === "on",
    ip: ip && z.union([z.ipv4(), z.ipv6()]).safeParse(ip).success ? ip : null,
    user_agent: h.get("user-agent")?.slice(0, 500) ?? null,
  });
  if (error) redirect(`/consent?error=${encodeURIComponent(error.message)}`);
  redirect("/profile");
}

export default async function ConsentPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { supabase, user } = await requireUser("/consent");
  const state = await getCandidateState(supabase, user.id);
  const { error } = await searchParams;

  return (
    <div className="space-y-6">
      <h1 className="h1">Before you upload your CV</h1>
      <article className="card max-h-[28rem] space-y-4 overflow-y-auto">
        <p className="muted">Privacy notice, version {NOTICE_VERSION}</p>
        {NOTICE_SECTIONS.map((s) => (
          <section key={s.title}>
            <h2 className="font-semibold">{s.title}</h2>
            {s.body.map((p, i) => (
              <p key={i} className="mt-1 text-sm text-slate-700">{p}</p>
            ))}
          </section>
        ))}
      </article>

      {state.consented ? (
        <p className="notice">
          You have already accepted this notice. <a href="/profile" className="underline">Continue to your profile</a>.
        </p>
      ) : (
        <form action={acceptConsent} className="card space-y-3 text-sm">
          <label className="flex gap-2">
            <input type="checkbox" name="accepted_processing" required />
            I have read the notice and agree that Chase Agents may process my personal information to assess my application.
          </label>
          <label className="flex gap-2">
            <input type="checkbox" name="accepted_ai_assessment" required />
            I understand that AI is used to parse my CV, run a screening interview and give advisory scores, and that a person makes every decision.
          </label>
          <label className="flex gap-2">
            <input type="checkbox" name="accepted_offshore_processing" required />
            I agree that my information may be processed outside South Africa by the providers named in the notice.
          </label>
          <label className="flex gap-2">
            <input type="checkbox" name="talent_pool_opt_in" />
            Optional: keep my details for 12 months so you can contact me about future roles (talent pool).
          </label>
          {error && <p className="error">Please tick the three required boxes to continue.</p>}
          <button className="btn">Accept and continue</button>
        </form>
      )}
    </div>
  );
}
