import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCandidateState, nextStep, requireUser } from "@/lib/server/auth";
import { rands, STAGE_LABEL, STATUS_LABEL } from "@/lib/format";
import Markdown from "@/components/markdown";

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
  const { data: others } = await supabase.from("roles").select("slug, title").eq("active", true).neq("slug", slug).order("title");
  const active = application && ["in_progress", "advanced"].includes(application.status);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="h1">{role.title}</h1>
        <p className="font-medium">
          {rands(role.salary_min)}–{rands(role.salary_max)} a month gross + year-end profit share · {role.location_note}
        </p>
        <p className="max-w-3xl text-lg text-slate-700">{role.summary}</p>
      </header>

      {application && (
        <div className="card space-y-3">
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
          <div className="flex flex-wrap gap-3">
            {active && application.stage === "interview" && (
              <Link href={`/apply/${role.slug}/interview`} className="btn">Next: AI CV interview (about 25 to 30 minutes)</Link>
            )}
            {active && application.stage === "quiz" && (
              <Link href={`/apply/${role.slug}/quiz`} className="btn">Next: role quiz (12 minutes)</Link>
            )}
            {active && (application.stage === "work_1" || application.stage === "work_2") && (
              <Link href={`/apply/${role.slug}/work/${application.stage}`} className="btn">
                Next: work assessment {application.stage === "work_1" ? "1" : "2"}
              </Link>
            )}
            <Link href="/me/results" className="btn-secondary">See my results</Link>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      )}

      <article className="card max-w-3xl">
        <Markdown source={role.jd_md || role.spec_md} />
      </article>

      {!application && (
        <div className="card max-w-3xl space-y-3" id="apply">
          <h2 className="h2">Think it&apos;s a fit?</h2>
          {!user ? (
            <>
              <p className="text-sm text-slate-700">
                Create an account, read our privacy notice, upload your CV and do the 15-minute Reasoning Assessment. Then
                come back here and apply.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Link href="/signup" className="btn">Create an account to apply</Link>
                <Link href={`/login?next=${encodeURIComponent(`/roles/${role.slug}`)}`} className="underline text-sm">I already have an account</Link>
              </div>
            </>
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
      )}

      {!!others?.length && (
        <p className="muted">
          Not quite you? Read the other half of the team:{" "}
          {others.map((o, i) => (
            <span key={o.slug}>
              {i > 0 && ", "}
              <Link href={`/roles/${o.slug}`} className="underline">{o.title}</Link>
            </span>
          ))}
          .
        </p>
      )}
    </div>
  );
}
