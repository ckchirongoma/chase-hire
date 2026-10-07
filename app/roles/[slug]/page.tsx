import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCandidateState, nextStep, requireUser } from "@/lib/server/auth";
import { rands, STAGE_LABEL, STATUS_LABEL } from "@/lib/format";

export const dynamic = "force-dynamic";

const APPLY_ERRORS: Record<string, string> = {
  consent_required: "Please accept the privacy notice first.",
  cv_required: "Please upload your CV first.",
  reasoning_required: "Please complete the Reasoning Assessment first.",
  role_not_found: "This role is no longer open.",
};

async function apply(formData: FormData) {
  "use server";
  const slug = String(formData.get("slug") ?? "");
  const { supabase } = await requireUser(`/roles/${slug}`);
  const { error } = await supabase.rpc("apply_to_role", { p_slug: slug });
  if (error) {
    const key = Object.keys(APPLY_ERRORS).find((k) => error.message.includes(k));
    redirect(`/roles/${slug}?error=${encodeURIComponent(key ? APPLY_ERRORS[key] : "Could not apply")}`);
  }
  redirect(`/roles/${slug}?applied=1`);
}

export default async function RolePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string; applied?: string }>;
}) {
  const { slug } = await params;
  const { error, applied } = await searchParams;
  const supabase = await createClient();
  const { data: role } = await supabase.from("roles").select("*").eq("slug", slug).eq("active", true).maybeSingle();
  if (!role) notFound();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const state = user ? await getCandidateState(supabase, user.id) : null;
  const { data: application } = user
    ? await supabase.from("applications").select("stage, status, below_hurdle").eq("role_id", role.id).eq("user_id", user.id).maybeSingle()
    : { data: null };
  const ready = state && nextStep(state) === "/me/results";

  return (
    <div className="space-y-4">
      <h1 className="h1">{role.title}</h1>
      <p className="font-medium">
        {rands(role.salary_min)}–{rands(role.salary_max)} a month gross + year-end profit share · {role.location_note}
      </p>
      <div className="card space-y-2 text-sm">
        <p>{role.summary}</p>
        <p className="whitespace-pre-line text-slate-700">{role.spec_md}</p>
      </div>

      <div className="card space-y-3">
        {application ? (
          <>
            <p className="text-sm">
              You have applied. Current stage: <strong>{STAGE_LABEL[application.stage]}</strong> ·{" "}
              <strong>{STATUS_LABEL[application.status]}</strong>
            </p>
            {application.below_hurdle && application.status === "awaiting_review" && (
              <p className="notice">
                Your Reasoning Assessment result is below this role&apos;s usual level, so a person on our team will
                review your whole application (including your CV and experience) before the next stage opens. This is not
                a rejection.
              </p>
            )}
            {applied && <p className="notice">Application received.</p>}
            {["in_progress", "advanced"].includes(application.status) && application.stage === "interview" && (
              <Link href={`/apply/${role.slug}/interview`} className="btn">Next: AI CV interview (about 20 minutes)</Link>
            )}
            {["in_progress", "advanced"].includes(application.status) && application.stage === "quiz" && (
              <Link href={`/apply/${role.slug}/quiz`} className="btn">Next: role quiz (12 minutes)</Link>
            )}
            <Link href="/me/results" className="btn-secondary">See my results</Link>
          </>
        ) : !user ? (
          <Link href={`/signup`} className="btn">Create an account to apply</Link>
        ) : ready ? (
          <form action={apply}>
            <input type="hidden" name="slug" value={role.slug} />
            <button className="btn">Apply for this role</button>
          </form>
        ) : (
          <p className="text-sm">
            Before you apply, finish your account setup.{" "}
            <Link href={nextStep(state!)} className="underline">Continue</Link>
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
